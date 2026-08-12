import numpy as np

import gymnasium as gym

from gymnasium import spaces



class RoadCarEnv(gym.Env):

    def __init__(self):

        super().__init__()

        # Track dimensions

        self.track_length = 1200.0

        self.road_top = 50.0

        self.road_bottom = 450.0

        self.road_center_y = 250.0

        

        # Action space: 0: Steer Up, 1: Maintain Line, 2: Steer Down

        self.action_space = spaces.Discrete(3)

        

        # Steering Lock Configuration

        # If running at ~60 FPS, 30 steps = 0.5s lockout. Adjust this number to tweak responsiveness.

        self.cooldown_steps = 10  # ~0.25s lock (or set to 30 for full 0.5s)

        

        # 7 Obstacles total: 5 along the track + 2 narrowing the finish line gate

        self.obstacles = np.array([

            [250.0, 200.0],

            [450.0, 320.0],

            [650.0, 150.0],

            [820.0, 250.0],

            [950.0, 200.0],

            # Finish Line Funnel Gate (Narrow passage around center y=250)

            [1080.0, 100.0],  # Top gate obstacle

            [1080.0, 400.0]   # Bottom gate obstacle

        ], dtype=np.float32)

        

        # Observation space: [car_x, car_y, vel_y, dist_to_obs1..7]

        self.observation_space = spaces.Box(

            low=-np.inf, high=np.inf, shape=(10,), dtype=np.float32

        )

        

        self.reset()



    def reset(self, seed=None, options=None):

        super().reset(seed=seed)

        self.car_x = 50.0

        self.car_y = self.road_center_y

        self.car_speed_x = 10.0

        self.car_vel_y = 0.0

        self.finish_x = 1100.0

        

        # Cooldown State Tracking

        self.last_steer_dir = 1  # 0: Up, 1: Straight, 2: Down

        self.steer_cooldown = 0   # Steps remaining until opposite turn is allowed

        

        return self._get_obs(), {}



    def _get_obs(self):

        car_pos = np.array([self.car_x, self.car_y])

        obs_distances = [np.linalg.norm(car_pos - obs) for obs in self.obstacles]

        

        obs_state = [

            self.car_x / self.track_length,

            (self.car_y - self.road_top) / (self.road_bottom - self.road_top),

            self.car_vel_y / 10.0,

            * [d / self.track_length for d in obs_distances]

        ]

        return np.array(obs_state, dtype=np.float32)



    def step(self, action):

        # 1. Enforce Steering Cooldown Lockout

        if self.steer_cooldown > 0:

            # Check if action is trying to steer in the OPPOSITE direction of the last active turn

            if (self.last_steer_dir == 0 and action == 2) or (self.last_steer_dir == 2 and action == 0):

                # Lockout active: Force car to go straight (1) instead of allowing rapid reversal

                action = 1

            self.steer_cooldown -= 1



        # 2. Execute Action & Update Cooldown Counter

        if action == 0:   # Up

            self.car_vel_y = -8.0

            if self.last_steer_dir != 0:

                self.steer_cooldown = self.cooldown_steps

            self.last_steer_dir = 0



        elif action == 2: # Down

            self.car_vel_y = 8.0

            if self.last_steer_dir != 2:

                self.steer_cooldown = self.cooldown_steps

            self.last_steer_dir = 2



        else:             # Straight

            self.car_vel_y = 0.0



        # Position updates

        self.car_y += self.car_vel_y

        self.car_x += self.car_speed_x



        # 3. Wall Crash Penalty

        if self.car_y <= self.road_top + 12 or self.car_y >= self.road_bottom - 12:

            return self._get_obs(), -100.0, True, False, {"reason": "wall_crash"}



        # 4. Obstacle Collision Penalty

        car_pos = np.array([self.car_x, self.car_y])

        for obs in self.obstacles:

            if np.linalg.norm(car_pos - obs) < 24.0:

                return self._get_obs(), -100.0, True, False, {"reason": "obstacle_crash"}



        # 5. Finish Line Goal Reward

        if self.car_x >= self.finish_x:

            return self._get_obs(), 300.0, True, False, {"reason": "success"}



        # Reward structure: Small positive reward for advancing + penalty for deviating off-center

        center_penalty = abs(self.car_y - self.road_center_y) * 0.005

        reward = 1.0 - center_penalty

        

        return self._get_obs(), reward, False, False, {}