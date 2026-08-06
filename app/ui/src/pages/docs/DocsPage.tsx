import { BookOpenText, Workflow } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import SyntaxHelp from './SyntaxHelp'
import { ExperimentProgramGuide } from './ExperimentProgramGuide'

export function DocsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const section = searchParams.get('section') === 'reference' ? 'reference' : 'program'

  return (
    <div className="min-h-full bg-white">
      <div className="sticky top-0 z-20 border-b bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
          <Button
            aria-pressed={section === 'program'}
            size="sm"
            variant={section === 'program' ? 'default' : 'ghost'}
            onClick={() => setSearchParams({ section: 'program' }, { replace: true })}
          >
            <Workflow />
            Experiment Program
          </Button>
          <Button
            aria-pressed={section === 'reference'}
            size="sm"
            variant={section === 'reference' ? 'default' : 'ghost'}
            onClick={() => setSearchParams({ section: 'reference' }, { replace: true })}
          >
            <BookOpenText />
            CAD Reference
          </Button>
        </div>
      </div>
      {section === 'program' ? <ExperimentProgramGuide /> : <SyntaxHelp />}
    </div>
  )
}

export const Component = DocsPage
