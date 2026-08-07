from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from sdk.slave import DataChannelMessage, SlaveContext

from app import __main__ as ai_slave
from app.voicevox import handlers as voicevox_handlers


def context() -> SlaveContext:
    return SlaveContext(session_id="session-1", ttl_seconds=60)


class VoicevoxHandlerTest(unittest.IsolatedAsyncioTestCase):
    async def test_speakers_returns_metadata(self) -> None:
        runtime = SimpleNamespace(
            speakers=Mock(
                return_value=[
                    {
                        "name": "Speaker",
                        "speaker_uuid": "speaker-1",
                        "styles": [{"id": 2, "name": "Normal", "type": "talk"}],
                    }
                ]
            )
        )

        with patch.object(voicevox_handlers, "get_voicevox_runtime", return_value=runtime):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(id="call-1", type="ai.voicevox.speakers", payload={}),
                context(),
            )

        self.assertEqual(response.type, "ai.voicevox.speakers.result")
        self.assertEqual(response.payload["speakers"][0]["speaker_uuid"], "speaker-1")
        self.assertEqual(response.attachments, [])
        runtime.speakers.assert_called_once_with()

    async def test_audio_query_preserves_query(self) -> None:
        audio_query = {"speedScale": 1.25, "accentPhrases": []}
        runtime = SimpleNamespace(create_audio_query=Mock(return_value=audio_query))

        with patch.object(voicevox_handlers, "get_voicevox_runtime", return_value=runtime):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.voicevox.audio_query",
                    payload={"text": "こんにちは", "speaker": 2},
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.voicevox.audio_query.result")
        self.assertEqual(response.payload, {"audio_query": audio_query})
        runtime.create_audio_query.assert_called_once_with("こんにちは", 2)

    async def test_synthesis_returns_wav_attachment(self) -> None:
        wav = b"RIFF\x04\x00\x00\x00WAVE"
        runtime = SimpleNamespace(synthesis=Mock(return_value=wav))
        audio_query = {"speedScale": 0.9, "accentPhrases": []}

        with patch.object(voicevox_handlers, "get_voicevox_runtime", return_value=runtime):
            response = await ai_slave.app.dispatch(
                DataChannelMessage(
                    id="call-1",
                    type="ai.voicevox.synthesis",
                    payload={
                        "audio_query": audio_query,
                        "speaker": 2,
                        "enable_interrogative_upspeak": False,
                    },
                ),
                context(),
            )

        self.assertEqual(response.type, "ai.voicevox.synthesis.result")
        self.assertEqual(
            response.payload,
            {"attachment_id": "audio-1", "mime_type": "audio/wav", "size": len(wav)},
        )
        self.assertEqual(response.attachments[0].mimeType, "audio/wav")
        self.assertEqual(response.attachments[0].data, wav)
        runtime.synthesis.assert_called_once_with(audio_query, 2, False)


if __name__ == "__main__":
    unittest.main()
