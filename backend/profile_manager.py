import os

import json

import shutil



PROFILES_DIR = "profiles"

os.makedirs(PROFILES_DIR, exist_ok=True)



def get_all_profiles():

    """Returns list of created profile metadata."""

    profiles = []

    if not os.path.exists(PROFILES_DIR):

        return profiles

        

    for name in os.listdir(PROFILES_DIR):

        meta_path = os.path.join(PROFILES_DIR, name, "metadata.json")

        if os.path.exists(meta_path):

            try:

                with open(meta_path, "r") as f:

                    data = json.load(f)

                    # Set default epsilon if reading older metadata without it

                    if "epsilon" not in data:

                        data["epsilon"] = 1.0

                    profiles.append(data)

            except Exception as e:

                print(f"Error reading metadata for {name}: {e}")

    return profiles



def create_profile(name: str):

    """Initializes a new profile folder."""

    profile_path = os.path.join(PROFILES_DIR, name)

    if os.path.exists(profile_path):

        raise ValueError("Profile already exists")

    

    os.makedirs(profile_path, exist_ok=True)

    metadata = {

        "name": name,

        "episodes_completed": 0,

        "successes": 0,

        "failures": 0,

        "best_reward": 0.0,

        "total_training_steps": 0,

        "epsilon": 1.0

    }

    _save_metadata(name, metadata)

    return metadata



def save_profile_stats(name: str, successes: int, failures: int, epsilon: float = 1.0):

    """Updates success/failure counters and epsilon in profile metadata."""

    meta_path = os.path.join(PROFILES_DIR, name, "metadata.json")

    metadata = {

        "name": name,

        "episodes_completed": successes + failures,

        "successes": successes,

        "failures": failures,

        "best_reward": 0.0,

        "total_training_steps": 0,

        "epsilon": float(epsilon)

    }

    if os.path.exists(meta_path):

        try:

            with open(meta_path, "r") as f:

                old_data = json.load(f)

                old_data["successes"] = successes

                old_data["failures"] = failures

                old_data["episodes_completed"] = successes + failures

                old_data["epsilon"] = float(epsilon)

                metadata = old_data

        except Exception:

            pass

    _save_metadata(name, metadata)



def delete_profile(name: str):

    """Deletes a profile directory and all its files."""

    profile_path = os.path.join(PROFILES_DIR, name)

    if os.path.exists(profile_path):

        shutil.rmtree(profile_path, ignore_errors=True)

        return True

    return False



def _save_metadata(name: str, metadata: dict):

    meta_path = os.path.join(PROFILES_DIR, name, "metadata.json")

    with open(meta_path, "w") as f:

        json.dump(metadata, f, indent=2)