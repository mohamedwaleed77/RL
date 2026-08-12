import numpy as np
import random
from collections import deque


def _he_init(fan_in, fan_out):
    return np.random.randn(fan_in, fan_out).astype(np.float32) * np.sqrt(2.0 / fan_in)


class DQNNetwork:
    """Plain 2-hidden-layer MLP, no autograd framework needed."""
    def __init__(self, state_dim=10, action_dim=3, hidden=64):
        self.W1 = _he_init(state_dim, hidden); self.b1 = np.zeros(hidden, dtype=np.float32)
        self.W2 = _he_init(hidden, hidden);     self.b2 = np.zeros(hidden, dtype=np.float32)
        self.W3 = _he_init(hidden, action_dim); self.b3 = np.zeros(action_dim, dtype=np.float32)

    def forward(self, x):
        # x: (batch, state_dim)
        z1 = x @ self.W1 + self.b1; h1 = np.maximum(z1, 0)
        z2 = h1 @ self.W2 + self.b2; h2 = np.maximum(z2, 0)
        out = h2 @ self.W3 + self.b3
        cache = (x, z1, h1, z2, h2)
        return out, cache

    def backward(self, cache, dout):
        x, z1, h1, z2, h2 = cache
        dW3 = h2.T @ dout
        db3 = dout.sum(axis=0)
        dh2 = dout @ self.W3.T
        dz2 = dh2 * (z2 > 0)
        dW2 = h1.T @ dz2
        db2 = dz2.sum(axis=0)
        dh1 = dz2 @ self.W2.T
        dz1 = dh1 * (z1 > 0)
        dW1 = x.T @ dz1
        db1 = dz1.sum(axis=0)
        return {"W1": dW1, "b1": db1, "W2": dW2, "b2": db2, "W3": dW3, "b3": db3}

    def params(self):
        return {"W1": self.W1, "b1": self.b1, "W2": self.W2, "b2": self.b2, "W3": self.W3, "b3": self.b3}

    def state_dict(self):
        return {k: v.copy() for k, v in self.params().items()}

    def load_state_dict(self, sd):
        for k, v in sd.items():
            setattr(self, k, v.astype(np.float32))


class AdamOptimizer:
    def __init__(self, params, lr=0.001, beta1=0.9, beta2=0.999, eps=1e-8):
        self.lr, self.beta1, self.beta2, self.eps = lr, beta1, beta2, eps
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def step(self, params, grads):
        self.t += 1
        for k in params:
            self.m[k] = self.beta1 * self.m[k] + (1 - self.beta1) * grads[k]
            self.v[k] = self.beta2 * self.v[k] + (1 - self.beta2) * (grads[k] ** 2)
            m_hat = self.m[k] / (1 - self.beta1 ** self.t)
            v_hat = self.v[k] / (1 - self.beta2 ** self.t)
            params[k] -= self.lr * m_hat / (np.sqrt(v_hat) + self.eps)

    def state_dict(self):
        return {"m": {k: v.copy() for k, v in self.m.items()},
                "v": {k: v.copy() for k, v in self.v.items()}, "t": self.t}

    def load_state_dict(self, sd):
        self.m = {k: v.copy() for k, v in sd["m"].items()}
        self.v = {k: v.copy() for k, v in sd["v"].items()}
        self.t = sd["t"]


class DQNAgent:
    def __init__(self, state_dim=10, action_dim=3):
        self.state_dim = state_dim
        self.action_dim = action_dim
        self.model = DQNNetwork(state_dim, action_dim)
        self.optimizer = AdamOptimizer(self.model.params(), lr=0.001)

        self.memory = deque(maxlen=20000)
        self.gamma = 0.98
        self.epsilon = 1.0
        self.epsilon_min = 0.05
        self.epsilon_decay = 0.998
        self.batch_size = 64

    def select_action(self, state):
        if random.random() < self.epsilon:
            return random.randint(0, self.action_dim - 1)
        q_values, _ = self.model.forward(np.asarray(state, dtype=np.float32)[None, :])
        return int(np.argmax(q_values[0]))

    def remember(self, state, action, reward, next_state, done):
        self.memory.append((state, action, reward, next_state, done))

    def train_step(self):
        if len(self.memory) < self.batch_size:
            return

        batch = random.sample(self.memory, self.batch_size)
        states, actions, rewards, next_states, dones = zip(*batch)

        states = np.asarray(states, dtype=np.float32)
        actions = np.asarray(actions, dtype=np.int64)
        rewards = np.asarray(rewards, dtype=np.float32)
        next_states = np.asarray(next_states, dtype=np.float32)
        dones = np.asarray(dones, dtype=np.float32)

        # Target
        next_q, _ = self.model.forward(next_states)
        max_next_q = next_q.max(axis=1)
        target_q = rewards + (1 - dones) * self.gamma * max_next_q

        # Current
        current_q, cache = self.model.forward(states)
        pred_q = current_q[np.arange(self.batch_size), actions]

        # dLoss/dOut for MSE only on chosen actions, zero elsewhere
        dout = np.zeros_like(current_q)
        error = (pred_q - target_q) / self.batch_size  # d(MSE)/d(pred)
        dout[np.arange(self.batch_size), actions] = 2 * error

        grads = self.model.backward(cache, dout)
        self.optimizer.step(self.model.params(), grads)

        if self.epsilon > self.epsilon_min:
            self.epsilon *= self.epsilon_decay

    def save(self, path):
        np.savez(
            path,
            **{f"model_{k}": v for k, v in self.model.state_dict().items()},
            epsilon=self.epsilon,
            opt_t=self.optimizer.t,
            **{f"opt_m_{k}": v for k, v in self.optimizer.m.items()},
            **{f"opt_v_{k}": v for k, v in self.optimizer.v.items()},
        )

    def load(self, path):
        data = np.load(path)
        model_sd = {k[len("model_"):]: data[k] for k in data.files if k.startswith("model_")}
        self.model.load_state_dict(model_sd)
        self.epsilon = float(data["epsilon"])
        if "opt_t" in data.files:
            self.optimizer.t = int(data["opt_t"])
            self.optimizer.m = {k[len("opt_m_"):]: data[k] for k in data.files if k.startswith("opt_m_")}
            self.optimizer.v = {k[len("opt_v_"):]: data[k] for k in data.files if k.startswith("opt_v_")}