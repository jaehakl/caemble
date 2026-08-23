import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from models import ExperimentSourceBundle, SaveExperimentRequest
from service.experiment import validate_source_bundle


def bundle(**extra: str) -> ExperimentSourceBundle:
    return ExperimentSourceBundle(
        formatVersion=6,
        files={
            "experiment.tsx": "export const Experiment = () => null\n",
            "geometry.tsx": "export {}\n",
            "material.tsx": "export {}\n",
            "simulate.py": "pass\n",
            **extra,
        },
    )


def test_bundle_v6_static_relative_imports_and_reexports_resolve():
    value = bundle(
        **{
            "experiment.tsx": (
                "import Main, { type Props } from './lib/main.tsx'\n"
                "import * as values from './lib/values'\n"
                "import './lib/side-effect'\n"
                "export * from './lib/public'\n"
                "void Main; void values\n"
            ),
            "lib/main.tsx": "export type Props = {}; export default 1\n",
            "lib/values/index.ts": "export const value = 1\n",
            "lib/side-effect.ts": "void 0\n",
            "lib/public.ts": "export const visible = true\n",
        }
    )
    assert validate_source_bundle(value)["formatVersion"] == 6


def test_bundle_v6_resolves_dotted_extensionless_module_paths():
    value = bundle(
        **{
            "experiment.tsx": "import { value } from './lib/value.helpers'\nvoid value\n",
            "lib/value.helpers.ts": "export const value = 1\n",
        }
    )

    assert "lib/value.helpers.ts" in validate_source_bundle(value)["files"]


def test_bundle_v6_uses_typescript_grammar_for_ts_angle_assertions():
    value = bundle(**{"lib/value.ts": "export const value = <number>1\n"})

    assert validate_source_bundle(value)["files"]["lib/value.ts"] == (
        "export const value = <number>1\n"
    )


def test_bundle_v6_uses_tsx_grammar_for_tsx_files():
    validate_source_bundle(bundle(**{"lib/component.tsx": "export const value = <div />\n"}))

    with pytest.raises(HTTPException, match=r"TSX syntax error in lib/value\.tsx"):
        validate_source_bundle(bundle(**{"lib/value.tsx": "export const value = <number>1\n"}))


def test_bundle_v6_still_rejects_invalid_typescript_syntax():
    with pytest.raises(HTTPException, match=r"TypeScript syntax error in lib/value\.ts"):
        validate_source_bundle(bundle(**{"lib/value.ts": "export const value =\n"}))


def test_bundle_v6_ignores_type_cycles_but_rejects_runtime_cycles():
    type_cycle = bundle(
        **{
            "geometry.tsx": "import type { B } from './types/b'; export type A = B\n",
            "types/b.ts": "import type { A } from '../geometry'; export type B = A\n",
        }
    )
    validate_source_bundle(type_cycle)

    runtime_cycle = bundle(
        **{
            "geometry.tsx": "import './runtime/b'; export {}\n",
            "runtime/b.ts": "import '../geometry'; export {}\n",
        }
    )
    with pytest.raises(HTTPException, match="cycle"):
        validate_source_bundle(runtime_cycle)


@pytest.mark.parametrize(
    "source",
    [
        'import helper = require("./lib/helper")\nexport { helper }\n',
        "const helper = 1\nexport = helper\n",
        'void import("./lib/helper")\n',
        'const helper = require("./lib/helper")\n',
    ],
)
def test_bundle_v6_rejects_non_static_module_syntax(source: str):
    with pytest.raises(HTTPException):
        validate_source_bundle(
            bundle(
                **{
                    "experiment.tsx": source,
                    "lib/helper.ts": "export const helper = 1\n",
                }
            )
        )


def test_bundle_v6_reports_deeply_nested_blocked_calls_as_validation_errors():
    nested_call = "(" * 2_000 + "require('./helper')" + ")" * 2_000

    with pytest.raises(HTTPException, match="Dynamic import and require") as caught:
        validate_source_bundle(
            bundle(
                **{
                    "lib/value.ts": f"export const value = {nested_call}\n",
                    "lib/helper.ts": "export const helper = 1\n",
                }
            )
        )

    assert caught.value.status_code == 422


@pytest.mark.parametrize(
    "core_import",
    [
        "import Core from '@caemble/core'",
        "import * as Core from '@caemble/core'",
        "import Core, { Box } from '@caemble/core'",
        "import '@caemble/core'",
        "import {} from '@caemble/core'",
    ],
)
def test_bundle_v6_allows_only_named_core_imports(core_import: str):
    with pytest.raises(HTTPException, match="named bindings"):
        validate_source_bundle(
            bundle(**{"geometry.tsx": f"{core_import}\nexport {{}}\n"})
        )


@pytest.mark.parametrize(
    "path",
    ["types.d.ts", "nested//file.ts", "nested/./file.ts", "nested/$file.ts", "/root.ts"],
)
def test_bundle_v6_rejects_unsupported_paths(path: str):
    with pytest.raises(HTTPException):
        validate_source_bundle(bundle(**{path: "export {}\n"}))


def test_bundle_v6_rejects_casefold_collisions_and_more_than_256_files():
    with pytest.raises(HTTPException, match="case-insensitively"):
        validate_source_bundle(bundle(**{"lib/Part.ts": "", "lib/part.ts": ""}))
    extras = {f"lib/f{index}.ts": "" for index in range(253)}
    with pytest.raises(HTTPException, match="at most 256"):
        validate_source_bundle(bundle(**extras))


def test_bundle_v6_rejects_text_that_cannot_be_encoded_as_utf8():
    with pytest.raises(HTTPException, match="valid UTF-8"):
        validate_source_bundle(bundle(**{"lib/invalid.ts": "\ud800"}))


@pytest.mark.parametrize(
    ("mode", "mode_fields"),
    [
        ("overwrite", {"experimentId": 1, "baseBundleHash": "0" * 64}),
        (
            "new_version",
            {"experimentId": 1, "baseBundleHash": "0" * 64, "bump": "patch"},
        ),
    ],
)
def test_initial_version_is_create_only(mode: str, mode_fields: dict[str, object]):
    source_bundle = bundle()
    common = {
        "mode": mode,
        "namespace": "test-space",
        "repository": "examples",
        "key": "beam",
        "name": "Beam",
        "sourceBundle": source_bundle,
        "bundleHash": "1" * 64,
        **mode_fields,
    }
    assert SaveExperimentRequest(**common).initialVersion == "0.1.0"
    with pytest.raises(ValidationError, match="does not accept.*initialVersion"):
        SaveExperimentRequest(**common, initialVersion="0.1.0")
