import { compile, formatExpandedPlan } from '../src/compiler.ts'
import healthSpec from '../examples/specs/smoke/health.ortheon.ts'
import checkoutSpec from '../examples/specs/checkout/authenticated-checkout.ortheon.ts'

console.log('=== HEALTH SPEC EXPANDED PLAN ===')
console.log(formatExpandedPlan(compile(healthSpec)))

console.log('')
console.log('=== AUTHENTICATED CHECKOUT EXPANDED PLAN ===')
console.log(formatExpandedPlan(compile(checkoutSpec)))
