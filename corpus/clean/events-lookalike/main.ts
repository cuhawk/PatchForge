import { readFile } from 'node:fs';
class EventEmitter {
  on(_name: string, _listener: (label: string) => void) {}
  emit(_name: string, _label: string) {}
}
function inspect(req: { body: string }) {
  const bus = new EventEmitter();
  bus.on('label', label => readFile(label, () => undefined));
  bus.emit('label', req.body);
}
