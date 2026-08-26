from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from cryptography.fernet import Fernet, InvalidToken, MultiFernet


SESSION_TTL_SECONDS = 12 * 60 * 60


class SessionEnvelopeError(ValueError):
    pass


@dataclass
class AgentSessionState:
    user_id: str
    provider: str
    model: str
    credential_fingerprint: str
    credential_version: int
    active_experiment_id: int | None
    workspace_session: int
    workspace_hash: str
    permission_fingerprint: str
    provider_items: list[dict[str, Any]] = field(default_factory=list)
    turns: list[dict[str, str]] = field(default_factory=list)
    working_memory: dict[str, Any] = field(default_factory=dict)
    provenance: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "provider": self.provider,
            "model": self.model,
            "credentialFingerprint": self.credential_fingerprint,
            "credentialVersion": self.credential_version,
            "activeExperimentId": self.active_experiment_id,
            "workspaceSession": self.workspace_session,
            "workspaceHash": self.workspace_hash,
            "permissionFingerprint": self.permission_fingerprint,
            "providerItems": self.provider_items,
            "turns": self.turns,
            "workingMemory": self.working_memory,
            "provenance": self.provenance,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentSessionState":
        provider_items = value.get("providerItems", [])
        turns = value.get("turns", [])
        working_memory = value.get("workingMemory", {})
        provenance = value.get("provenance", [])
        active_experiment_id = value.get("activeExperimentId")
        credential_version = value.get("credentialVersion")
        workspace_session = value.get("workspaceSession")
        return cls(
            user_id=value["userId"],
            provider=value["provider"],
            model=value["model"],
            credential_fingerprint=value["credentialFingerprint"],
            credential_version=credential_version,
            active_experiment_id=active_experiment_id,
            workspace_session=workspace_session,
            workspace_hash=value["workspaceHash"],
            permission_fingerprint=value["permissionFingerprint"],
            provider_items=provider_items,
            turns=turns,
            working_memory=working_memory,
            provenance=provenance,
        )


class SessionEnvelopeCodec:
    def __init__(self, keys: Iterable[str | bytes]):
        fernets = [Fernet(_derive_session_key(key)) for key in keys]
        if not fernets:
            raise SessionEnvelopeError("Agent session encryption is not configured")
        self._fernet = MultiFernet(fernets)

    def seal(self, state: AgentSessionState) -> str:
        raw = json.dumps(
            state.as_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        token = self._fernet.encrypt(raw)
        return token.decode("ascii")

    def open(
        self,
        token: str,
        *,
        user_id: str,
        provider: str,
        model: str,
        credential_fingerprint: str,
        credential_version: int,
        active_experiment_id: int | None,
        workspace_session: int,
        workspace_hash: str,
        permission_fingerprint: str,
    ) -> AgentSessionState:
        try:
            token_bytes = token.encode("ascii")
        except UnicodeEncodeError as error:
            raise SessionEnvelopeError("Agent session envelope is invalid") from error
        try:
            raw = self._fernet.decrypt(token_bytes, ttl=SESSION_TTL_SECONDS)
            value = json.loads(raw)
        except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SessionEnvelopeError("Agent session envelope is invalid or expired") from error
        if not isinstance(value, dict):
            raise SessionEnvelopeError("Agent session envelope is invalid")
        state = AgentSessionState.from_dict(value)
        expected = (
            user_id,
            provider,
            model,
            credential_fingerprint,
            permission_fingerprint,
        )
        actual = (
            state.user_id,
            state.provider,
            state.model,
            state.credential_fingerprint,
            state.permission_fingerprint,
        )
        if (
            state.active_experiment_id != active_experiment_id
            or state.workspace_session != workspace_session
            or not hmac.compare_digest(state.workspace_hash, workspace_hash)
            or not all(
                hmac.compare_digest(left, right)
                for left, right in zip(actual, expected, strict=True)
            )
        ):
            raise SessionEnvelopeError("Agent session envelope does not belong to this session")
        if state.credential_version != credential_version:
            raise SessionEnvelopeError("Agent session envelope does not belong to this session")
        return state


def credential_fingerprint(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def _derive_session_key(key: str | bytes) -> bytes:
    encoded = key.encode("ascii") if isinstance(key, str) else key
    try:
        raw = base64.urlsafe_b64decode(encoded)
    except (ValueError, TypeError) as error:
        raise SessionEnvelopeError("Agent session encryption is not configured") from error
    if len(raw) != 32:
        raise SessionEnvelopeError("Agent session encryption is not configured")
    derived = hmac.new(raw, b"caemble-ai-session-envelope-v1", hashlib.sha256).digest()
    return base64.urlsafe_b64encode(derived)
