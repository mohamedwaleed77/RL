import os
import random
import asyncio
from collections import deque
import numpy as np

import torch
import torch.nn as nn
import torch.optim as optim

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import profile_manager as pm
from car_env import RoadCarEnv

# --- PyTorch DQN Neural Network ---
class DQNNetwork(nn.Module):
    def __init__(self, state_dim=10, action_dim=3):
        super(DQNNetwork, self).__init__()
        self.fc = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 64),
            nn.ReLU(),
            nn.Linear(64, action_dim)
        )

    def forward(self, x):
        return self.fc(x)

class DQNAgent:
    def __init__(self, state_dim=10, action_dim=3):
        self.state_dim = state_dim
        self.action_dim = action_dim
        
        self.model = DQNNetwork(state_dim, action_dim)
        self.optimizer = optim.Adam(self.model.parameters(), lr=0.001)
        self.criterion = nn.MSELoss()
        
        self.memory = deque(maxlen=20000)
        self.gamma = 0.90            # Reduced from 0.95: focuses slightly less on long-term future
        self.epsilon = 1.0
        self.epsilon_min = 0.05
        self.epsilon_decay = 0.998   # Increased from 0.995: slower decay = harder/longer exploration
        self.batch_size = 64         # Increased from 32: larger training batches

    def select_action(self, state):
        if random.random() < self.epsilon:
            return random.randint(0, self.action_dim - 1)
        state_t = torch.FloatTensor(state).unsqueeze(0)
        with torch.no_grad():
            q_values = self.model(state_t)
        return torch.argmax(q_values).item()

    def remember(self, state, action, reward, next_state, done):
        self.memory.append((state, action, reward, next_state, done))

    def train_step(self):
        if len(self.memory) < self.batch_size:
            return
        
        batch = random.sample(self.memory, self.batch_size)
        states, actions, rewards, next_states, dones = zip(*batch)

        states_t = torch.FloatTensor(np.array(states))
        actions_t = torch.LongTensor(actions).unsqueeze(1)
        rewards_t = torch.FloatTensor(rewards)
        next_states_t = torch.FloatTensor(np.array(next_states))
        dones_t = torch.FloatTensor(dones)

        current_q = self.model(states_t).gather(1, actions_t).squeeze(1)
        
        with torch.no_grad():
            max_next_q = self.model(next_states_t).max(1)[0]
            target_q = rewards_t + (1 - dones_t) * self.gamma * max_next_q

        loss = self.criterion(current_q, target_q)
        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()

        if self.epsilon > self.epsilon_min:
            self.epsilon *= self.epsilon_decay

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
        model_path = os.path.join("profiles", profile_name, "model.pt")
        if os.path.exists(model_path):
            try:
                agent.model.load_state_dict(torch.load(model_path))
                agent.epsilon = 0.1
            except Exception as e:
                print("Failed to load weights:", e)
        else:
            agent.epsilon = 1.0
                
        profiles = pm.get_all_profiles()
        for p in profiles:
            if p.get("name") == profile_name:
                successes = p.get("successes", 0)
                failures = p.get("failures", 0)
                break

    def save_agent_weights(profile_name):
        if not profile_name:
            return
        model_path = os.path.join("profiles", profile_name, "model.pt")
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        torch.save(agent.model.state_dict(), model_path)
        pm.save_profile_stats(profile_name, successes, failures)

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
                        pm.save_profile_stats(current_profile, successes, failures)

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
        
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)