function example() { const sample = Buffer.from('MQ==', 'base64'); return new Function(sample.toString()); }
