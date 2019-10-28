// @flow

import {
  responseActions,
  type WorkerExecutorType,
  type WorkerResponseAction,
  type WorkerExecutorPayload,
  type WorkerResponsePayload,
} from './common'

type PromiseResponse = WorkerResponsePayload => void
type WorkerAction = {
  resolve: PromiseResponse,
  reject: PromiseResponse,
}
type WorkerActions = WorkerAction[]

const { RESPONSE_SUCCESS, RESPONSE_ERROR } = responseActions

function createWorker(useWebWorker: boolean): Worker {
  if (useWebWorker) {
    const LokiWebWorker = (require('./worker/index.worker'): any)
    return new LokiWebWorker()
  }

  const WebWorkerMock = (require('./worker/workerMock').default: any)
  return new WebWorkerMock()
}

class WorkerBridge {
  _worker: Worker

  _pendingRequests: WorkerActions = []

  constructor(useWebWorker: boolean): void {
    this._worker = createWorker(useWebWorker)
    this._worker.onmessage = ({ data }) => {
      const { type, payload }: WorkerResponseAction = (data: any)
      const { resolve, reject } = this._pendingRequests.shift()

      if (type === RESPONSE_ERROR) {
        reject(payload)
      } else if (type === RESPONSE_SUCCESS) {
        resolve(payload)
      }
    }
  }

  // TODO: `any` should be `WorkerResponsePayload` here
  send(
    type: WorkerExecutorType,
    payload: WorkerExecutorPayload = [],
    cloneMethod: 'shallowCloneDeepObjects' | 'immutable' | 'deep' = 'deep',
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this._pendingRequests.push({ resolve, reject })

      this._worker.postMessage({
        type,
        payload,
        cloneMethod,
      })
    })
  }
}

export default WorkerBridge
