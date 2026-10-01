from sdk.slave import run_app

from .runtime import create_app

app = create_app()

if __name__ == "__main__":
    run_app(app)
