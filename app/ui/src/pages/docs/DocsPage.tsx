import { BookOpenText, Workflow } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import SyntaxHelp from './SyntaxHelp'
import { ExperimentProgramGuide } from './ExperimentProgramGuide'

export function ManualWorkspace({ onOpenWorkbench }: { onOpenWorkbench?: () => void }) {
  const [section, setSection] = useState<'program' | 'reference'>('program')

  return (
    <div className="min-h-full bg-white">
      <div className="sticky top-0 z-20 border-b bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
          <Button
            aria-pressed={section === 'program'}
            size="sm"
            variant={section === 'program' ? 'default' : 'ghost'}
            onClick={() => setSection('program')}
          >
            <Workflow />
            Experiment Program
          </Button>
          <Button
            aria-pressed={section === 'reference'}
            size="sm"
            variant={section === 'reference' ? 'default' : 'ghost'}
            onClick={() => setSection('reference')}
          >
            <BookOpenText />
            CAD Reference
          </Button>
        </div>
      </div>
      {section === 'program' ? <ExperimentProgramGuide onOpenWorkbench={onOpenWorkbench} /> : <SyntaxHelp />}
    </div>
  )
}
