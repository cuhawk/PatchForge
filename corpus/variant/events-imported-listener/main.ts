import { register } from './helper.js';
import { EventEmitter as Bus } from 'events';
function inspect(req: { body: string }) {
  const bus = new Bus();
  register(bus);
  bus.emit('label', 'fixed', req.body);
}
