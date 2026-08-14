import { describe, expect, it } from 'vitest'
import pageSource from './CaePage.tsx?raw'
import chromeSource from './useCaePageChrome.tsx?raw'
import dialogSource from './CaeWorkbenchDialogs.tsx?raw'

describe('integrated CAE page surface', () => {
  it('uses one Experiment editor and a prepared/recorded Measurement workflow', () => {
    expect(pageSource).toContain('<ExperimentEditor')
    expect(pageSource).toContain('<RecordedDataEditor')
    expect(pageSource).not.toContain('<StructureEditor')
    expect(chromeSource).toContain('Generate Candidate')
    expect(chromeSource).toContain('Save Current Measurement')
    expect(chromeSource).toContain('Duplicate Measurement')
    expect(chromeSource).toContain('Run Selected')
    expect(chromeSource).toContain('Retry Saving Results')
    expect(chromeSource).toContain("label: 'Data'")
  })

  it('does not expose Research, Sample, Setup, or overwrite-run dialogs', () => {
    for (const legacy of ['ResearchPickerDialog', 'RealizationPickerDialog', 'Generate Sample', 'Generate Setup']) {
      expect(dialogSource + chromeSource).not.toContain(legacy)
    }
    expect(chromeSource).not.toContain('overwrite')
  })

  it('opens AI Helper as a persistent Editor Dock tab instead of a utility dialog', () => {
    expect(pageSource).toContain('<AiHelperWorkspace')
    expect(chromeSource).toContain("onSelect: () => openTab('ai-helper')")
    expect(dialogSource).not.toContain('AiHelperWorkspace')
    expect(dialogSource).not.toContain('ai-helper')
  })
})
