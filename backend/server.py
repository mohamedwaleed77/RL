import os

import random

import asyncio

from collections import deque

import numpy as np


# Remove: import torch, torch.nn, torch.optim, and the DQNNetwork/DQNAgent classes
from numpy_dqn import DQNAgent


from fastapi import FastAPI, HTTPException

from fastapi.middleware.cors import CORSMiddleware

from fastapi import WebSocket, WebSocketDisconnect

from fastapi.staticfiles import StaticFiles

from fastapi.responses import FileResponse

from pydantic import BaseModel


import profile_manager as pm

from car_env import RoadCarEnv







# --- FastAPI App Setup ---

app = FastAPI()



app.add_middleware(

    CORSMiddleware,

    allow_origins=["*"],

    allow_credentials=True,

    allow_methods=["*"],

    allow_headers=["*"],

)



class CreateProfileRequest(BaseModel):

    name: str



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

    success = pm.delete_profile(name)

    if not success:

        raise HTTPException(status_code=404, detail="Profile not found")

    return {"status": "success", "deleted": name}



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
        model_path = os.path.join("profiles", profile_name, "model.npz")
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        agent.save(model_path)
        pm.save_profile_stats(profile_name, successes, failures, epsilon=agent.epsilon)



    try:

        while True:

            # Outer non-blocking command listener (when idle or between episodes)

            try:

                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.005)

                command = data.get("command")

                

                if command == "select_profile":

                    current_profile = data.get("name")

                    load_agent_weights(current_profile)

                    await websocket.send_json({"type": "status", "message": f"Selected {current_profile}"})



                elif command == "start_simulation":

                    if current_profile:

                        is_running = True

                    else:

                        await websocket.send_json({"type": "error", "message": "No profile selected"})



                elif command == "stop_simulation":

                    is_running = False

                    save_agent_weights(current_profile)



            except asyncio.TimeoutError:

                pass



            # Simulation Episode Loop

            if is_running and current_profile:

                state, _ = env.reset()

                done = False

                total_reward = 0

                

                while not done and is_running:

                    # Check for stop / incoming commands mid-step

                    try:

                        data = await asyncio.wait_for(websocket.receive_json(), timeout=0.001)

                        cmd = data.get("command")

                        if cmd == "stop_simulation":

                            is_running = False

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

                        pm.save_profile_stats(current_profile, successes, failures, epsilon=agent.epsilon)



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



                    # Pause handling at the end of an episode

                    if done:

                        # Split sleep into small chunks while listening for stop requests

                        for _ in range(100):  # 100 * 0.01s = 1.0s total pause

                            if not is_running:

                                break

                            try:

                                data = await asyncio.wait_for(websocket.receive_json(), timeout=0.01)

                                if data.get("command") == "stop_simulation":

                                    is_running = False

                                    save_agent_weights(current_profile)

                                    break

                            except asyncio.TimeoutError:

                                pass

                    else:

                        await asyncio.sleep(0.01)  # Normal frame delay (~100 FPS)



                save_agent_weights(current_profile)



            await asyncio.sleep(0.005)



    except WebSocketDisconnect:

        print("Client disconnected cleanly")

    except Exception as e:

        print("WebSocket Error:", e)



# --- Serve React Static Files ---

static_dir = os.path.join(os.path.dirname(__file__), "static_build")



if os.path.exists(static_dir):

    # Mounts the whole static_build folder at root path '/'.

    # html=True automatically routes '/' to index.html and serves car.svg, favicon, etc.

    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")



    # Serve index.html at root route

    @app.get("/")

    async def serve_index():

        return FileResponse(os.path.join(static_dir, "index.html"))



if __name__ == "__main__":

    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)