import os
import random
import asyncio
from collections import deque
import numpy as np

from numpy_dqn import DQNAgent
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import profile_manager as pm
from car_env import RoadCarEnv

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active profiles registry to prevent race conditions during deletion
active_simulations = set()

class CreateProfileRequest(BaseModel):
    name: str

# --------------------------------------------------
# REST API Endpoints
# --------------------------------------------------

@app.get("/api/profiles")
def list_profiles():
    return pm.get_all_profiles()

@app.post("/api/profiles")
def create_new_profile(req: CreateProfileRequest):
    try:
        return pm.create_profile(req.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/api/profiles/{name}")
def remove_profile(name: str):
    # Prevent deleting a profile that is currently being simulated
    if name in active_simulations:
        raise HTTPException(
            status_code=400, 
            detail="Cannot delete profile while a simulation is actively running. Stop the simulation first."
        )
    
    success = pm.delete_profile(name)
    if not success:
        raise HTTPException(status_code=404, detail="Profile not found")
    return {"status": "success", "deleted": name}


# --------------------------------------------------
# WebSocket Endpoint
# --------------------------------------------------

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    env = RoadCarEnv()
    agent = DQNAgent()
    
    current_profile = None
    is_running = False
    successes = 0
    failures = 0
    
    def load_agent_weights(profile_name):
        nonlocal agent, successes, failures
        agent = DQNAgent()
        model_path = os.path.join("profiles", profile_name, "model.npz")

        profiles = pm.get_all_profiles()
        profile_data = next((p for p in profiles if p.get("name") == profile_name), {})
        successes = profile_data.get("successes", 0)
        failures = profile_data.get("failures", 0)

        if os.path.exists(model_path):
            try:
                agent.load(model_path)
            except Exception as e:
                print("Failed to load weights checkpoint:", e)
                agent.epsilon = 1.0
        else:
            agent.epsilon = 1.0

    def save_agent_weights(profile_name):
        if not profile_name:
            return
        
        profile_dir = os.path.join("profiles", profile_name)
        # Check if profile folder still exists before saving to prevent resurrecting deleted profiles
        if not os.path.exists(profile_dir):
            return

        model_path = os.path.join(profile_dir, "model.npz")
        agent.save(model_path)
        pm.save_profile_stats(profile_name, successes, failures, epsilon=agent.epsilon)

    try:
        while True:
            # Outer command listener
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.005)
                command = data.get("command")
                
                if command == "select_profile":
                    new_profile = data.get("name")
                    if is_running and current_profile:
                        active_simulations.discard(current_profile)
                        is_running = False
                    
                    current_profile = new_profile
                    load_agent_weights(current_profile)
                    await websocket.send_json({"type": "status", "message": f"Selected {current_profile}"})

                elif command == "start_simulation":
                    if current_profile and pm.profile_exists(current_profile):
                        is_running = True
                        active_simulations.add(current_profile)
                    else:
                        await websocket.send_json({"type": "error", "message": "No valid profile selected"})

                elif command == "stop_simulation":
                    is_running = False
                    if current_profile:
                        active_simulations.discard(current_profile)
                        save_agent_weights(current_profile)

            except asyncio.TimeoutError:
                pass

            # Simulation Episode Loop
            if is_running and current_profile:
                # Double-check profile presence mid-loop
                if not pm.profile_exists(current_profile):
                    is_running = False
                    active_simulations.discard(current_profile)
                    current_profile = None
                    await websocket.send_json({"type": "error", "message": "Active profile was removed."})
                    continue

                state, _ = env.reset()
                done = False
                total_reward = 0
                
                while not done and is_running:
                    try:
                        data = await asyncio.wait_for(websocket.receive_json(), timeout=0.001)
                        cmd = data.get("command")
                        if cmd == "stop_simulation":
                            is_running = False
                            active_simulations.discard(current_profile)
                            save_agent_weights(current_profile)
                            break
                    except asyncio.TimeoutError:
                        pass

                    action = agent.select_action(state)
                    next_state, reward, terminated, truncated, info = env.step(action)
                    done = terminated or truncated
                    total_reward += reward

                    agent.remember(state, action, reward, next_state, done)
                    agent.train_step()
                    state = next_state

                    if done:
                        if info.get("reason") == "success":
                            successes += 1
                        else:
                            failures += 1
                        save_agent_weights(current_profile)

                    state_frame = {
                        "type": "frame",
                        "profile": current_profile,
                        "car": {"x": float(env.car_x), "y": float(env.car_y)},
                        "obstacles": [{"x": float(o[0]), "y": float(o[1])} for o in env.obstacles],
                        "finish_x": float(env.finish_x),
                        "reward": float(reward),
                        "total_reward": float(total_reward),
                        "epsilon": float(agent.epsilon),
                        "successes": successes,
                        "failures": failures,
                        "done": done,
                        "info": info
                    }
                    await websocket.send_json(state_frame)

                    if done:
                        for _ in range(100):
                            if not is_running:
                                break
                            try:
                                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.01)
                                if data.get("command") == "stop_simulation":
                                    is_running = False
                                    active_simulations.discard(current_profile)
                                    save_agent_weights(current_profile)
                                    break
                            except asyncio.TimeoutError:
                                pass
                    else:
                        await asyncio.sleep(0.01)

                save_agent_weights(current_profile)

            await asyncio.sleep(0.005)

    except WebSocketDisconnect:
        print("Client disconnected cleanly")
    except Exception as e:
        print("WebSocket Error:", e)
    finally:
        if current_profile:
            active_simulations.discard(current_profile)


# --------------------------------------------------
# Static Build & SPA Routing Setup
# --------------------------------------------------

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static_build")

if os.path.exists(STATIC_DIR):
    # Mount /static subfolder for JS/CSS bundles generated by React build
    static_assets = os.path.join(STATIC_DIR, "static")
    if os.path.exists(static_assets):
        app.mount("/static", StaticFiles(directory=static_assets), name="static")

    # Serve static files or fallback to index.html for React SPA routes
    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        # Do not catch unmatched API or WS routes
        if full_path.startswith("api") or full_path.startswith("ws"):
            raise HTTPException(status_code=404, detail="API endpoint not found")

        file_path = os.path.join(STATIC_DIR, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)

        index_file = os.path.join(STATIC_DIR, "index.html")
        if os.path.exists(index_file):
            return FileResponse(index_file)

        raise HTTPException(status_code=404, detail="Frontend index.html not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)