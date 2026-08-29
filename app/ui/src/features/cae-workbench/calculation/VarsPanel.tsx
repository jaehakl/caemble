import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
import { TensorEditor } from './TensorEditor'

type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export function VarsPanel({
  candidateSessionKey,
  disabled,
  editorResetKey,
  schema,
  vars,
  onVariableChange,
}: {
  candidateSessionKey: string
  disabled: boolean
  editorResetKey?: string | number
  schema: VarsSchema | null
  vars: Readonly<Vars> | null
  onVariableChange: (key: string, value: Tensor) => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const previousSessionRef = useRef(candidateSessionKey)
  const schemaKey = useMemo(
    () =>
      schema
        ? JSON.stringify(Object.entries(schema).map(([key, entry]) => [key, entry.shape, entry.min, entry.max]))
        : 'none',
    [schema],
  )
  const previousSchemaRef = useRef(schemaKey)
  useEffect(() => {
    if (previousSessionRef.current !== candidateSessionKey || previousSchemaRef.current !== schemaKey) {
      setSelectedKey(null)
    }
    previousSessionRef.current = candidateSessionKey
    previousSchemaRef.current = schemaKey
  }, [candidateSessionKey, schemaKey])

  const entry = selectedKey && schema ? schema[selectedKey] : undefined
  const value = selectedKey && vars ? vars[selectedKey] : undefined
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded border">
        {!schema || !vars ? (
          <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
            {disabled ? <LoaderCircle className="size-4 animate-spin" /> : '평가된 Candidate가 없습니다.'}
          </div>
        ) : Object.keys(schema).length ? (
          <div className="grid gap-2 p-2">
            {Object.entries(schema).map(([key, item]) => (
              <button
                className="rounded border px-2 py-2 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled || vars[key] === undefined}
                key={key}
                type="button"
                onClick={() => setSelectedKey(key)}
              >
                <span className="block truncate font-mono font-medium">{key}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                  <Badge>{item.shape.length === 0 ? 'scalar' : JSON.stringify(item.shape)}</Badge>
                  <span>
                    {item.min} – {item.max}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
            varsSchema 항목이 없습니다.
          </div>
        )}
      </div>
      <Dialog
        modal={false}
        open={Boolean(selectedKey && entry && value !== undefined)}
        onOpenChange={(open) => !open && setSelectedKey(null)}
      >
        {selectedKey && entry && value !== undefined ? (
          <DialogContent
            className="top-32 right-2 bottom-9 left-auto max-h-none w-[min(48vw,900px)] max-w-none translate-x-0 translate-y-0 overflow-hidden p-4 sm:max-w-none"
            hideOverlay
            onInteractOutside={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle className="font-mono">{selectedKey}</DialogTitle>
              <DialogDescription>
                shape {JSON.stringify(entry.shape)} · range [{entry.min}, {entry.max}]
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto">
              <TensorEditor
                disabled={disabled}
                key={`${candidateSessionKey}:${schemaKey}:${selectedKey}`}
                label={selectedKey}
                maximum={entry.max}
                minimum={entry.min}
                resetKey={editorResetKey}
                shape={entry.shape}
                value={value}
                onValueChange={(next) => onVariableChange(selectedKey, next)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSelectedKey(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  )
}
