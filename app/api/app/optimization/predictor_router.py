"""HTTP facade for attempt-scoped Evaluation child Predictor sessions."""
from fastapi import APIRouter, Depends, Header, Query

from db import get_db
from gpstation.models import JobAnswerWaitResult, JobCreateRequest
from optimization import predictor_jobs

router = APIRouter(prefix="/optimization/evaluation", tags=["optimization-evaluation"])


@router.post("/{parent_id}/attempts/{attempt_id}/predictor-jobs")
async def create_child(parent_id: str, attempt_id: str, body: JobCreateRequest,
                       authorization: str = Header(default=""), db=Depends(get_db)):
    return await predictor_jobs.create_child(parent_id, attempt_id, body, authorization, db)


@router.get("/{parent_id}/attempts/{attempt_id}/predictor-jobs/{child_id}/wait-answer", response_model=JobAnswerWaitResult)
async def wait_answer(parent_id: str, attempt_id: str, child_id: str,
                      wait_seconds: float = Query(default=30, ge=0, le=30),
                      authorization: str = Header(default=""), db=Depends(get_db)):
    return await predictor_jobs.wait_answer(parent_id, attempt_id, child_id, wait_seconds, authorization, db)


@router.post("/{parent_id}/attempts/{attempt_id}/predictor-jobs/{child_id}/kill")
async def kill_child(parent_id: str, attempt_id: str, child_id: str,
                     authorization: str = Header(default=""), db=Depends(get_db)):
    return await predictor_jobs.kill_child(parent_id, attempt_id, child_id, authorization, db)
