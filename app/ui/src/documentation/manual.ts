import page0 from '../../../../docs/manual/workbench/workbench-quickstart.md?raw'
import page1 from '../../../../docs/manual/workbench/workbench-authoring-cycle.md?raw'
import page2 from '../../../../docs/manual/workbench/workbench-calculation.md?raw'
import page3 from '../../../../docs/manual/workbench/workbench-prediction.md?raw'
import page4 from '../../../../docs/manual/workbench/workbench-admin-demo-curation.md?raw'
import page5 from '../../../../docs/manual/workbench/workbench-analysis.md?raw'
import page6 from '../../../../docs/manual/workbench/workbench-viewer-selection.md?raw'
import page7 from '../../../../docs/manual/program/program-overview.md?raw'
import page8 from '../../../../docs/manual/program/program-definition.md?raw'
import page9 from '../../../../docs/manual/program/program-materials.md?raw'
import page10 from '../../../../docs/manual/program/program-task.md?raw'
import page11 from '../../../../docs/manual/program/program-ray-tracing.md?raw'
import page12 from '../../../../docs/manual/program/program-simulate.md?raw'
import page13 from '../../../../docs/manual/program/program-runtime-rules.md?raw'
import page14 from '../../../../docs/manual/program/program-domain-recording.md?raw'
import page15 from '../../../../docs/manual/program/program-verified-examples.md?raw'
import page16 from '../../../../docs/manual/program/program-multiphysics-example.md?raw'
import page17 from '../../../../docs/manual/reference/reference-source-import.md?raw'
import page18 from '../../../../docs/manual/reference/reference-geometry-skeleton.md?raw'
import page19 from '../../../../docs/manual/reference/reference-geometry-transforms.md?raw'
import page20 from '../../../../docs/manual/reference/reference-geometry-identity.md?raw'
import page21 from '../../../../docs/manual/reference/reference-geometry-elements.md?raw'
import page22 from '../../../../docs/manual/reference/reference-core-api.md?raw'
import page23 from '../../../../docs/manual/reference/reference-data-schema.md?raw'
import page24 from '../../../../docs/manual/reference/reference-targets-results.md?raw'
import page25 from '../../../../docs/manual/troubleshooting/troubleshooting-ready.md?raw'
import page26 from '../../../../docs/manual/troubleshooting/troubleshooting-target-manifest.md?raw'
import page27 from '../../../../docs/manual/troubleshooting/troubleshooting-units-materials.md?raw'
import page28 from '../../../../docs/manual/troubleshooting/troubleshooting-runtime-results.md?raw'
import type { DocumentPage } from './types'
import { manualBody } from './body'

export const manualDocuments: readonly DocumentPage[] = [
  {
    ...{
      id: 'workbench-quickstart',
      section: 'workbench',
      anchor: 'workbench-quickstart',
      title: 'CAE Workbench 빠른 시작',
      summary: 'Experiment candidate를 준비하고 Measurement로 고정한 뒤 실행하는 전체 흐름입니다.',
      keywords: ['Quickstart', '시작', 'Candidate', 'Measurement', 'Prepared', 'Recorded', 'Launcher', 'Ready'],
    },
    sourcePath: 'docs/manual/workbench/workbench-quickstart.md',
    content: manualBody(page0),
  },
  {
    ...{
      id: 'workbench-authoring-cycle',
      section: 'workbench',
      anchor: 'workbench-authoring-cycle',
      title: '편집, Candidate 생성과 실행 결과의 관계',
      summary: 'source 수정과 candidate 생성이 prepared·recorded Measurement에 미치는 영향을 설명합니다.',
      keywords: [
        'Dirty',
        'Checking',
        'Compiling',
        'Evaluating',
        'Validating Models',
        'Candidate',
        'Prepared',
        'Recorded',
      ],
    },
    sourcePath: 'docs/manual/workbench/workbench-authoring-cycle.md',
    content: manualBody(page1),
  },
  {
    ...{
      id: 'workbench-calculation',
      section: 'workbench',
      anchor: 'workbench-calculation',
      title: 'Calculation으로 RecordedData 후처리',
      summary:
        '선택한 Measurement의 RecordedData를 JavaScript와 Math.js로 계산하고 scalar, line, heatmap으로 확인합니다.',
      keywords: [
        'Calculation',
        'Vars',
        'Candidate',
        'RecordedData',
        'Math.js',
        'mathjs',
        'Output',
        'scalar',
        'line',
        'heatmap',
      ],
    },
    sourcePath: 'docs/manual/workbench/workbench-calculation.md',
    content: manualBody(page2),
  },
  {
    ...{
      id: 'workbench-prediction',
      section: 'workbench',
      anchor: 'workbench-prediction',
      title: 'Prediction으로 Vars와 CalculationData 상호 예측',
      summary:
        '저장된 Measurement의 k-Nearest Neighbor 모델로 Forward·Inverse 예측을 자동 전환하고 Save & Run으로 검증합니다.',
      keywords: [
        'Prediction',
        'Forward',
        'Inverse',
        'kNN',
        'k-Nearest Neighbor',
        'Vars',
        'RecordedData',
        'CalculationData',
        'Save & Run',
        'Validation',
      ],
    },
    sourcePath: 'docs/manual/workbench/workbench-prediction.md',
    content: manualBody(page3),
  },
  {
    ...{
      id: 'workbench-admin-demo-curation',
      section: 'workbench',
      anchor: 'workbench-admin-demo-curation',
      title: 'Admin: 공개 Demo 큐레이션',
      summary: '관리자가 공개 Prediction Demo의 순서와 대표 항목을 관리하고 공개 범위를 확인합니다.',
      keywords: ['Admin', 'Demo', 'Curation', 'Model Catalog', 'Users', '공개', '대표 Demo'],
    },
    sourcePath: 'docs/manual/workbench/workbench-admin-demo-curation.md',
    content: manualBody(page4),
  },
  {
    ...{
      id: 'workbench-analysis',
      section: 'workbench',
      anchor: 'workbench-analysis',
      title: 'Analysis: Explore, Mining과 Data',
      summary: 'CalculationData가 저장된 Measurement를 탐색하고 고급 분석과 CSV 내보내기를 사용하는 방법입니다.',
      keywords: ['Analysis', 'Explore', 'Pearson', 'Spearman', 'Mining', 'PCA', 'CSV'],
    },
    sourcePath: 'docs/manual/workbench/workbench-analysis.md',
    content: manualBody(page5),
  },
  {
    ...{
      id: 'workbench-viewer-selection',
      section: 'workbench',
      anchor: 'workbench-viewer-selection',
      title: '3D Viewer에서 Geometry와 Surface ID 확인',
      summary: 'Viewer 클릭과 Source의 ID 선택을 연결해 실제 Scene 전역 경로를 확인합니다.',
      keywords: ['Viewer', 'Geometry ID', 'Surface ID', 'selection', '전역 경로', 'surface'],
    },
    sourcePath: 'docs/manual/workbench/workbench-viewer-selection.md',
    content: manualBody(page6),
  },
  {
    ...{
      id: 'program-overview',
      section: 'program',
      anchor: 'experiment-program-overview',
      aliases: ['experiment-program-mental-model', 'experiment-physical-model'],
      title: 'Experiment Program의 파일과 책임',
      summary: '공통 계약, named task와 Python orchestration을 독립 파일로 나눕니다.',
      keywords: [
        'Experiment Program',
        'experiment.tsx',
        'geometry.tsx',
        'material.tsx',
        'tasks',
        'simulate.py',
        'orchestration',
      ],
    },
    sourcePath: 'docs/manual/program/program-overview.md',
    content: manualBody(page7),
  },
  {
    ...{
      id: 'program-definition',
      section: 'program',
      anchor: 'experiment-program-definition',
      aliases: ['experiment-vars-geometry'],
      title: 'experiment.tsx: 변수와 RecordedData 계약',
      summary: '실험 공통 변수와 Measurement에 남길 최종 데이터만 선언합니다.',
      keywords: ['experiment()', 'varsSchema', 'recordedData', 'DataSchema', 'Measurement'],
    },
    sourcePath: 'docs/manual/program/program-definition.md',
    content: manualBody(page8),
  },
  {
    ...{
      id: 'program-materials',
      section: 'program',
      anchor: 'experiment-program-materials',
      aliases: ['experiment-materials', 'experiment-program-material-roles'],
      title: 'Material 역할과 Model Parameter',
      summary: '모델 인스턴스와 명시적인 계수를 선언하고 Geometry 역할로 연결합니다.',
      keywords: [
        'Material',
        'material.tsx',
        'role map',
        'body',
        'Mat',
        'canonical key',
        'dtype',
        'unit',
        'modelGroups',
        'tire',
        'wheel',
      ],
    },
    sourcePath: 'docs/manual/program/program-materials.md',
    content: manualBody(page9),
  },
  {
    ...{
      id: 'program-task',
      section: 'program',
      anchor: 'experiment-program-task',
      aliases: ['experiment-program-minimal-pair', 'experiment-program-kernel-limits', 'experiment-program-methods'],
      title: 'tasks/*.tsx: solver task 선언',
      summary: 'manifest의 parameter, method, target과 output 계약을 defineTask로 작성합니다.',
      keywords: ['defineTask', 'kernel', 'config', 'parameters', 'initializations', 'boundaryConditions', 'outputs'],
    },
    sourcePath: 'docs/manual/program/program-task.md',
    content: manualBody(page10),
  },
  {
    ...{
      id: 'program-ray-tracing',
      section: 'program',
      anchor: 'experiment-program-ray-tracing',
      aliases: ['non-sequential-ray-tracing', 'ray-tracing-thin-film'],
      title: 'Non-sequential Ray Tracing',
      summary: '광선의 비순차 추적, 적응형 박막 처리와 detector 결과를 구성하는 방법입니다.',
      keywords: [
        'ray-tracing@0.4.0',
        'non-sequential',
        'point source',
        'area source',
        'directional source',
        'Lambertian source',
        'Stokes',
        'ABg',
        'Henyey-Greenstein',
        'detector',
        'thin film',
        'TMM',
        '50 um',
        'frequency',
        'ray paths',
      ],
    },
    sourcePath: 'docs/manual/program/program-ray-tracing.md',
    content: manualBody(page11),
  },
  {
    ...{
      id: 'program-simulate',
      section: 'program',
      anchor: 'experiment-program-simulate',
      title: 'simulate.py: 실행, 전달, 기록',
      summary: 'sim.run, sim.record, sim.release로 Task 실행과 state·artifact의 수명을 제어합니다.',
      keywords: ['simulate', 'sim.run', 'sim.record', 'sim.release', 'artifact', 'state', 'inputs'],
    },
    sourcePath: 'docs/manual/program/program-simulate.md',
    content: manualBody(page12),
  },
  {
    ...{
      id: 'program-runtime-rules',
      section: 'program',
      anchor: 'experiment-program-runtime-rules',
      aliases: ['experiment-program-troubleshooting'],
      title: '실행 중 state와 artifact 규칙',
      summary: 'state와 artifact의 해제, checkpoint, rollback과 RecordedData ACK 규칙입니다.',
      keywords: ['state', 'artifact', 'rollback', 'provisional', 'ACK', 'fatal', 'release'],
    },
    sourcePath: 'docs/manual/program/program-runtime-rules.md',
    content: manualBody(page13),
  },
  {
    ...{
      id: 'program-domain-recording',
      section: 'program',
      anchor: 'experiment-program-domain-recording',
      title: 'Domain을 함께 보존하는 RecordedData',
      summary: 'Field artifact의 좌표, connectivity와 물리적 의미를 명시적인 기록 group에 보존합니다.',
      keywords: ['RecordedData', 'FieldValue', 'domain', 'mesh', 'connectivity', 'quantity', 'valueUnit'],
    },
    sourcePath: 'docs/manual/program/program-domain-recording.md',
    content: manualBody(page14),
  },
  {
    ...{
      id: 'program-verified-examples',
      section: 'program',
      anchor: 'experiment-program-examples',
      aliases: ['experiment-verified-example'],
      title: '검증된 Examples',
      summary: '실제 UI-CAE fixture로 검증되는 단계별 Experiment Program입니다.',
      keywords: ['program examples', 'DC', 'current density', 'notched', 'electro thermal', 'multiphysics'],
    },
    sourcePath: 'docs/manual/program/program-verified-examples.md',
    content: manualBody(page15),
  },
  {
    ...{
      id: 'program-multiphysics-example',
      section: 'program',
      anchor: 'experiment-program-multiphysics',
      title: 'Multiphysics 예제: Electro-Thermal Notched Bar',
      summary: 'DC의 Joule heating artifact를 정상상태 Heat task로 전달하는 orchestration입니다.',
      keywords: ['multiphysics', 'Joule heating', 'heatSource', 'electric', 'thermal'],
      collapsed: true,
    },
    sourcePath: 'docs/manual/program/program-multiphysics-example.md',
    content: manualBody(page16),
  },
  {
    ...{
      id: 'reference-source-import',
      section: 'reference',
      anchor: 'cad-reference-overview',
      aliases: ['cad-reference-source-import'],
      title: '공개 Source와 import 경계',
      summary: 'TSX source에서 사용할 수 있는 @caemble/core 공개 경계를 설명합니다.',
      keywords: ['CAD Reference', '@caemble/core', 'import', 'default export', 'compile', 'evaluate'],
    },
    sourcePath: 'docs/manual/reference/reference-source-import.md',
    content: manualBody(page17),
  },
  {
    ...{
      id: 'reference-geometry-skeleton',
      section: 'reference',
      anchor: 'cad-reference-geometry-skeleton',
      title: 'Geometry 저작 골격과 좌표계',
      summary: 'CAD API v1 source의 기본 구조, 필수 prop 기본값, PascalCase primitive와 제어문 활용을 함께 보여줍니다.',
      keywords: [
        'CAD API v1',
        'geometry.tsx',
        'Geometry',
        'PascalCase',
        'loop',
        'control flow',
        'right-handed',
        'lengthUnit',
        '좌표계',
      ],
    },
    sourcePath: 'docs/manual/reference/reference-geometry-skeleton.md',
    content: manualBody(page18),
  },
  {
    ...{
      id: 'reference-geometry-transforms',
      section: 'reference',
      anchor: 'cad-reference-geometry-transforms',
      aliases: ['cad-reference-v7-migration'],
      title: 'Transform: direct props와 operation wrapper',
      summary: 'direct Euler prop과 계층적인 translate·rotate·scale wrapper를 구분해 사용합니다.',
      keywords: [
        'position',
        'rotation',
        'scale',
        'translate',
        'axis angle',
        'radians',
        'Euler',
        'transform order',
        'pos',
        'rotate',
      ],
    },
    sourcePath: 'docs/manual/reference/reference-geometry-transforms.md',
    content: manualBody(page19),
  },
  {
    ...{
      id: 'reference-geometry-identity',
      section: 'reference',
      anchor: 'cad-reference-geometry-identity',
      title: 'ID, group과 surface identity',
      summary: '안정적인 solver target을 위해 component, primitive와 operation의 소유권을 구분합니다.',
      keywords: [
        'id',
        'identity',
        'geometryGroup',
        'surfaceGroup',
        'numeric surface',
        'surface-N',
        'operation',
        'Fragment',
      ],
    },
    sourcePath: 'docs/manual/reference/reference-geometry-identity.md',
    content: manualBody(page20),
  },
  {
    ...{
      id: 'reference-geometry-elements',
      section: 'reference',
      anchor: 'cad-reference-geometry-elements',
      title: 'Primitive 선택과 operation 규칙',
      summary: '가장 단순한 primitive에서 시작하고 child cardinality와 순서 계약을 지킵니다.',
      keywords: ['box', 'cylinder', 'sphere', 'fiber', 'array', 'shell', 'union', 'subtract', 'intersect', 'children'],
    },
    sourcePath: 'docs/manual/reference/reference-geometry-elements.md',
    content: manualBody(page21),
  },
  {
    ...{
      id: 'reference-core-api',
      section: 'reference',
      anchor: 'cad-reference-core-api',
      aliases: ['cad-reference-primitives', 'cad-reference-operations', 'cad-reference-vars-geometry'],
      title: '@caemble/core 핵심 API',
      summary: 'CAE 저작에서 가장 자주 사용하는 공개 symbol의 책임을 정리합니다.',
      keywords: ['experiment', 'defineTask', 'Material', 'Mat', 'Geometry', 'Vec3', 'DataSchema'],
    },
    sourcePath: 'docs/manual/reference/reference-core-api.md',
    content: manualBody(page22),
  },
  {
    ...{
      id: 'reference-data-schema',
      section: 'reference',
      anchor: 'cad-reference-data-schema',
      aliases: ['cad-reference-material'],
      title: 'DataSchema, QuantityKind와 UCUM 단위',
      summary: 'scalar·tensor shape와 물리 의미, 변환 가능한 단위를 함께 선언합니다.',
      keywords: ['DataSchema', 'dtype', 'axes', 'shape', 'QuantityKind', 'UCUM', 'unit', 'tensorOrder'],
    },
    sourcePath: 'docs/manual/reference/reference-data-schema.md',
    content: manualBody(page23),
  },
  {
    ...{
      id: 'reference-targets-results',
      section: 'reference',
      anchor: 'cad-reference-targets-results',
      aliases: ['cad-reference-task-recorded-data', 'cad-reference-kernels', 'cad-reference-results'],
      title: 'Target, run 상태와 결과 경계',
      summary: 'Experiment/Task scene target과 RecordedData가 worker 경계를 통과하는 방식을 설명합니다.',
      keywords: ['target', 'experiment.geometry', 'task.geometry', 'run status', 'RecordedData', 'trace', 'provenance'],
    },
    sourcePath: 'docs/manual/reference/reference-targets-results.md',
    content: manualBody(page24),
  },
  {
    ...{
      id: 'troubleshooting-ready',
      section: 'troubleshooting',
      anchor: 'troubleshooting-ready',
      title: '문서가 Ready가 되지 않을 때',
      summary: 'compile/evaluate 단계와 source 위치를 기준으로 오류를 좁힙니다.',
      keywords: ['troubleshooting', 'Ready', 'compile', 'evaluate', 'diagnostic', 'source error'],
    },
    sourcePath: 'docs/manual/troubleshooting/troubleshooting-ready.md',
    content: manualBody(page25),
  },
  {
    ...{
      id: 'troubleshooting-target-manifest',
      section: 'troubleshooting',
      anchor: 'troubleshooting-target-manifest',
      title: 'target 또는 solver manifest 오류',
      summary: 'solver identity, method occurrence와 group target을 현재 manifest에 맞춥니다.',
      keywords: ['target', 'manifest', 'methodId', 'occurrence', 'group', 'solver', 'invalid_manifest'],
    },
    sourcePath: 'docs/manual/troubleshooting/troubleshooting-target-manifest.md',
    content: manualBody(page26),
  },
  {
    ...{
      id: 'troubleshooting-units-materials',
      section: 'troubleshooting',
      anchor: 'troubleshooting-units-materials',
      title: 'unit, QuantityKind 또는 Material 오류',
      summary: 'canonical key와 변환 가능한 UCUM 단위, tensor shape를 함께 점검합니다.',
      keywords: ['invalid_unit', 'UCUM', 'QuantityKind', 'Material', 'tensor', 'conductivity'],
    },
    sourcePath: 'docs/manual/troubleshooting/troubleshooting-units-materials.md',
    content: manualBody(page27),
  },
  {
    ...{
      id: 'troubleshooting-runtime-results',
      section: 'troubleshooting',
      anchor: 'troubleshooting-runtime-results',
      title: 'Measurement 실행 또는 결과 오류',
      summary: '선택 입력, artifact 수명과 RecordedData 계약을 순서대로 점검합니다.',
      keywords: ['Measurement', 'artifact', 'recordedData', 'stale', 'failed', 'cancelled', 'Launcher'],
    },
    sourcePath: 'docs/manual/troubleshooting/troubleshooting-runtime-results.md',
    content: manualBody(page28),
  },
]
