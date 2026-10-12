import { describe, expect, it } from 'vitest';
import { parsePatient } from '../../src/shared/validation';
import { syntheticPatient } from '../support/fixtures';

const invalidPhones = [
  '', '123456789', '12345678901', '080-000-0000', '(080) 000 0000',
  '+66800000000', ' 0800000000', '0800000000 ', '0800000000\n',
  '0800000000\u00a0', '08000\t00000', '08000a0000', '๐๘๐๐๐๐๐๐๐๐',
  '０８００００００００', '٠٨٠٠٠٠٠٠٠٠', 800000000, null, undefined,
];

describe('patient phone contract', () => {
  it.each(['0800000000', '0000000000', '1234567890'])('retains exactly ten ASCII digits: %s', phone => {
    expect(parsePatient({ ...syntheticPatient, phone }).phone).toBe(phone);
  });

  it.each(invalidPhones)('rejects the unmodified phone value %j', phone => {
    expect(() => parsePatient({ ...syntheticPatient, phone })).toThrow();
  });
});
