import { type FrameOutputAnswer, type FrameOutputRequest, createFrameOutputService } from './frame-output-service';

interface FrameOutputWorkerScope {
  onmessage: ((event: MessageEvent<FrameOutputRequest>) => void) | null;
  postMessage: (answer: FrameOutputAnswer) => void;
}

const scope = globalThis as unknown as FrameOutputWorkerScope;
const answer = createFrameOutputService();

scope.onmessage = event => {
  const reply = answer(event.data);
  if (reply) scope.postMessage(reply);
};
