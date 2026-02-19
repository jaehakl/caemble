cd ..
call .venv\Scripts\activate
cd read_only
python -m uvicorn api.index:app --host 127.0.0.1 --port 8000