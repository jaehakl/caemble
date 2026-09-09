"""Render only the bucket origin into Nginx; never copy credentials to static files."""
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import dotenv_values

config_path, env_path = map(Path, sys.argv[1:])
text = config_path.read_text(encoding="utf-8")
if "__CAEMBLE_STORAGE_ORIGIN__" in text:
    values = dotenv_values(env_path)
    endpoint = values.get("S3_ENDPOINT_URL")
    if not endpoint:
        region = values.get("AWS_REGION", "")
        if not re.fullmatch(r"[a-z0-9-]+", region):
            raise SystemExit("AWS_REGION is required to render the bucket CSP origin.")
        suffix = "amazonaws.com.cn" if region.startswith("cn-") else "amazonaws.com"
        endpoint = f"https://s3.{region}.{suffix}"
    parsed = urlsplit(endpoint)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc
            or not re.fullmatch(r"[a-zA-Z0-9.-]+(?::[0-9]+)?", parsed.netloc)):
        raise SystemExit("S3_ENDPOINT_URL must have a valid HTTP(S) host.")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    config_path.write_text(text.replace("__CAEMBLE_STORAGE_ORIGIN__", origin), encoding="utf-8", newline="\n")
