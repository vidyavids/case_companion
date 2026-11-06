"""Shared Clocked client for the Case Companion Python test.

Reads CLOCKED_API_KEY from the environment only (never hard-coded).
Base URL and model are the SDK defaults: https://clocked.rezolve.ai/clocked.
"""

import os

from clocked_sdk import Clocked
from dotenv import load_dotenv


def get_client() -> Clocked:
    """Build a Clocked client. Raises if CLOCKED_API_KEY is missing."""
    load_dotenv()  # optional local .env; env vars still win
    if not os.environ.get("CLOCKED_API_KEY"):
        raise RuntimeError(
            "CLOCKED_API_KEY is not set. Copy py/.env.example to py/.env "
            "and add your key, or export CLOCKED_API_KEY."
        )
    return Clocked()
