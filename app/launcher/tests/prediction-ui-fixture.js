import React from 'react';
import { createRoot } from 'react-dom/client';
import { predictedRecordedData } from '/src/features/prediction/data.ts';
import { calculatePrediction } from '/src/features/prediction/usePredictionModels.ts';
import { BoxGridResult } from '/src/features/viewer/viewer/BoxGridResult.tsx';
import JscadViewer from '/src/features/viewer/viewer/JscadViewer.tsx';
import '/src/index.css';

export async function displayAndCalculate(model, result) {
  const candidateBox = {
    ...result.output[0].layout.boxGrid,
    origin: [20, 30, 40], size: [4, 6, 8],
    rotation: [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  };
  const recorded = predictedRecordedData(result.output, model.rules, undefined, { 'heat.T': candidateBox });
  const source = { kind: 'prediction', candidate: { fingerprint: 'candidate-x-half', sourceHash: 'fixture', vars: { x: .5 } }, model: result.provenance, modelFingerprint: result.fingerprint };
  const preview = { recorded, rules: model.rules, resultContracts: {}, result, source, modelFingerprint: result.fingerprint };
  const host = document.getElementById('fixture');
  const root = createRoot(host);
  const rendered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Predicted BoxGrid Viewer did not render.')), 30000);
    const onRendered = () => { clearTimeout(timeout); resolve(); };
    root.render(React.createElement(BoxGridResult, {
      name: 'heat.T', rules: preview.rules, data: preview.recorded, displayUnit: 'm', canOverlayGeometry: true,
      renderViewer: (heatmapRenderData, geometryOpacity) => React.createElement(JscadViewer, {
        layers: [], lengthUnit: 'm', heatmapRenderData, geometryOpacity,
        onRenderStart: () => {}, onRenderEnd: onRendered,
        onRenderError: message => { clearTimeout(timeout); reject(new Error(message)); },
      }),
    }));
  });
  await rendered;
  const canvasCount = host.querySelectorAll('canvas').length;
  if (!canvasCount) throw new Error('Predicted BoxGrid is missing its Viewer canvas.');
  const context = { experimentRecords: [{ id: 10, name: 'heat.T' }] };
  const calculations = [{ id: 4, name: 'Maximum', experiment_record_ids: [10], contract_status: 'ready',
    output_layout: { dtype: 'float64', shape: [], axes: [] },
    source_code: 'import { max } from "mathjs"; export default function calculate(record) { return { dtype: "float64", data: max(record["heat.T"].data), axes: [] }; }',
  }];
  const analyzed = await calculatePrediction(preview, calculations, context, new AbortController().signal);
  if (Object.keys(analyzed.errors).length) throw new Error(JSON.stringify(analyzed.errors));
  if (analyzed.source !== preview.source) throw new Error('Calculation lost prediction provenance.');
  const output = { calculated: analyzed.values[4].data, candidateOrigin: recorded['heat.T'].boxGrid.origin, sourceKind: analyzed.source.kind, canvasCount };
  root.unmount();
  return output;
}
