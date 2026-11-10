/** Host Typert artifact (`./typert`): the Remote method the Gateway serves. */

import { CALL_SIGNATURE, PACKAGE, SERVICE, TYPERT_REMOTE } from './remote-info.ts'

/** Read by the DSH Typert loader. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors },
  model: {
    services: [{
      description: 'Her memory management for the plugin page.',
      summary: 'Her memory management.',
      tags: [],
      key: SERVICE,
      exportName: 'HerMemoryRemote',
      types: [],
      members: [{ kind: 'method', name: 'call', signature: CALL_SIGNATURE, summary: 'Run one management operation.' }],
    }],
    events: [],
    objects: [],
  },
}
