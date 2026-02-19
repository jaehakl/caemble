cd ..
call .venv-admin\Scripts\activate
cd admin
python -m uvicorn api.index:app --host 127.0.0.1 --port 8000