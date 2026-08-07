from __future__ import annotations

import unittest

from app.llm.generation import (
    LOW_THINKING_INSTRUCTION,
    GenerationOutputParser,
    apply_thinking_effort,
)


class GenerationPolicyTest(unittest.TestCase):
    def test_low_thinking_instruction_is_applied_to_a_copy(self) -> None:
        messages = [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "prompt"},
        ]

        generated = apply_thinking_effort(messages, True, "low")

        self.assertEqual(generated[0]["content"], f"system\n\n{LOW_THINKING_INSTRUCTION}")
        self.assertEqual(messages[0]["content"], "system")

    def test_low_instruction_is_not_applied_when_disabled_or_default(self) -> None:
        messages = [{"role": "system", "content": "system"}]

        self.assertEqual(apply_thinking_effort(messages, False, "low"), messages)
        self.assertEqual(apply_thinking_effort(messages, True, "default"), messages)


class GenerationOutputParserTest(unittest.TestCase):
    def test_gemma_reasoning_markers_can_span_chunks(self) -> None:
        parser = GenerationOutputParser(expect_reasoning=True, response_format="text")

        emitted = [
            parser.feed("<|chan"),
            parser.feed("nel>thought\nsecret"),
            parser.feed(" reasoning<chan"),
            parser.feed("nel|>final "),
            parser.feed("answer<turn|>"),
        ]
        output = parser.finish("gemma")

        self.assertNotIn("secret reasoning", "".join(emitted) + output.pending_delta)
        self.assertEqual("".join(emitted) + output.pending_delta, "final answer")
        self.assertEqual(output.answer, "final answer")
        self.assertEqual(output.reasoning_format, "gemma")

    def test_qwen_closing_only_marker_can_span_chunks(self) -> None:
        parser = GenerationOutputParser(expect_reasoning=True, response_format="text")

        emitted = [
            parser.feed("secret reasoning</thi"),
            parser.feed("nk>final "),
            parser.feed("answer"),
        ]
        output = parser.finish("qwen")

        self.assertNotIn("secret reasoning", "".join(emitted) + output.pending_delta)
        self.assertEqual("".join(emitted) + output.pending_delta, "final answer")
        self.assertEqual(output.answer, "final answer")
        self.assertEqual(output.reasoning_format, "qwen")

    def test_markerless_thinking_output_is_released_at_finish(self) -> None:
        parser = GenerationOutputParser(expect_reasoning=True, response_format="text")

        self.assertEqual(parser.feed("direct final answer"), "")
        output = parser.finish("model")

        self.assertEqual(output.pending_delta, "direct final answer")
        self.assertEqual(output.answer, "direct final answer")

    def test_json_is_buffered_validated_and_recovered_once(self) -> None:
        parser = GenerationOutputParser(expect_reasoning=True, response_format="json")

        self.assertEqual(parser.feed("reasoning</think>Result: "), "")
        self.assertEqual(parser.feed('```json\n{"value":{"nested":true}}\n```'), "")
        output = parser.finish("model")

        self.assertEqual(output.answer, '{"value":{"nested":true}}')
        self.assertEqual(output.pending_delta, output.answer)
        self.assertTrue(output.json_recovered)

    def test_json_rejects_multiple_objects_and_arrays(self) -> None:
        for value in ('{"first":1} {"second":2}', '[{"value":1}]'):
            with self.subTest(value=value):
                parser = GenerationOutputParser(expect_reasoning=False, response_format="json")
                parser.feed(value)
                with self.assertRaises(RuntimeError):
                    parser.finish("model")

    def test_unterminated_reasoning_is_rejected(self) -> None:
        for value in ("<|channel>thought\nsecret", "<think>secret"):
            with self.subTest(value=value):
                parser = GenerationOutputParser(expect_reasoning=True, response_format="text")
                parser.feed(value)
                with self.assertRaises(RuntimeError):
                    parser.finish("model")


if __name__ == "__main__":
    unittest.main()
