import { calculationAccessPolicy } from '@/features/cae-workbench/calculation/calculationAccessPolicy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const anonymousDemo = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: true,
  experimentManageable: false,
})
assert(anonymousDemo.demoSandbox, 'anonymous Demo must use the local Calculation sandbox')
assert(anonymousDemo.sourceEditable, 'anonymous Demo Calculation source must be editable locally')
assert(!anonymousDemo.persistable, 'anonymous Demo Calculation must not be persisted')

const authenticatedDemo = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: true,
  experimentManageable: false,
})
assert(authenticatedDemo.sourceEditable, 'authenticated Demo viewers must keep the same local sandbox')
assert(!authenticatedDemo.persistable, 'authenticated Demo viewers must not mutate the Demo')

const owner = calculationAccessPolicy({
  dataReadable: true,
  experimentIsDemo: false,
  experimentManageable: true,
})
assert(owner.sourceEditable && owner.persistable, 'owned non-Demo Calculations must remain editable and persistable')

const anonymousPrivate = calculationAccessPolicy({
  dataReadable: false,
  experimentIsDemo: false,
  experimentManageable: false,
})
assert(!anonymousPrivate.sourceEditable, 'private Calculations must remain unavailable to anonymous users')
assert(!anonymousPrivate.persistable, 'private Calculations must remain non-persistable to anonymous users')

console.log('Public Demo Calculation access tests passed.')
