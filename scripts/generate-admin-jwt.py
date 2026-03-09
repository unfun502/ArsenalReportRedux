#!/usr/bin/env python3
"""
Generate an arsenal_admin JWT for use in admin/.env
Uses the shared JWT_SECRET from the VPS .env file.

Usage:
  python scripts/generate-admin-jwt.py

Output:
  Prints ADMIN_JWT=<token> ready to paste into admin/.env
"""

import hmac
import hashlib
import base64
import json
import time

# ── CONFIGURE THIS ──────────────────────────────────────────────────────────
# Paste the JWT_SECRET from VPS ~/.env here (the shared PostgREST secret)
JWT_SECRET = "PASTE_JWT_SECRET_HERE"
# ────────────────────────────────────────────────────────────────────────────


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_jwt(secret: str, role: str, exp_days: int = 3650) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "role": role,
        "iat": int(time.time()),
        "exp": int(time.time()) + (exp_days * 86400),
    }

    header_b64 = b64url(json.dumps(header, separators=(",", ":")).encode())
    payload_b64 = b64url(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_b64}.{payload_b64}".encode()

    secret_bytes = secret.encode("utf-8")
    signature = hmac.new(secret_bytes, signing_input, hashlib.sha256).digest()
    sig_b64 = b64url(signature)

    return f"{header_b64}.{payload_b64}.{sig_b64}"


if __name__ == "__main__":
    if JWT_SECRET == "PASTE_JWT_SECRET_HERE":
        print("ERROR: Edit this script and paste your JWT_SECRET before running.")
        print("Find it in ~/.env on the VPS (VPS-REFERENCE.md for details).")
        exit(1)

    token = generate_jwt(JWT_SECRET, role="arsenal_admin")
    print("\nAdd this line to admin/.env:\n")
    print(f"ADMIN_JWT={token}")
    print(f"\n(Expires in 10 years — regenerate if JWT_SECRET changes)\n")
