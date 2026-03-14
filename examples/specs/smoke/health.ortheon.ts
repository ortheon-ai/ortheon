import { spec, flow, step, api, expect, ref, env } from '../../../src/dsl.js'
import { healthApi } from '../../contracts/orders.js'

export default spec('service health check', {
  baseUrl: env('APP_BASE_URL'),
  apis: {
    ...healthApi,
  },
  flows: [
    flow('health check', {
      steps: [
        step('check health endpoint',
          api('health', {
            expect: {
              status: 200,
              body: {
                status: 'ok',
              },
            },
            save: {
              healthStatus: 'body.status',
            },
          })
        ),
        step('health status should equal ok',
          expect(ref('healthStatus'), 'equals', 'ok')
        ),
      ],
    }),
  ],
})
