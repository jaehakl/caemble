import os
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

class Settings(BaseModel):
    db_url: str = os.getenv("CAEMBLE_DB_URL", "")

settings = Settings()
print(settings)