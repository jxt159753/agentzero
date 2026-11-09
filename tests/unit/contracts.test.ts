import { describe,it,expect } from 'vitest';
import { parseAmount } from '../../packages/contracts/src/index.js';
import { hash } from '../../apps/api/src/core.js';
import { loadConfig } from '../../apps/api/src/config.js';
describe('shared contract boundaries',()=>{
  it('preserves values above the JavaScript integer precision limit',()=>{
    expect(parseAmount('9007199254740993').toString()).toBe('9007199254740993');
    expect(parseAmount('9223372036854775807')).toBe(9223372036854775807n);
    for(const value of ['-1','1.1','01','1e3','9223372036854775808']) expect(()=>parseAmount(value)).toThrow();
    expect(()=>parseAmount('0',true)).toThrow();
  });
  it('canonical request hashes ignore object order and preserve amounts',()=>{
    expect(hash({b:'2',a:'1'})).toEqual(hash({a:'1',b:'2'}));
    expect(hash({a:'9007199254740993'})).not.toEqual(hash({a:'9007199254740992'}));
  });
  it('requires HTTPS outside loopback development',()=>{
    expect(()=>loadConfig({DATABASE_URL:'postgres://example',PUBLIC_ORIGIN:'http://example.com'})).toThrow();
    expect(()=>loadConfig({DATABASE_URL:'postgres://example',PUBLIC_ORIGIN:'http://localhost:5173',NODE_ENV:'production'})).toThrow();
  });
});
