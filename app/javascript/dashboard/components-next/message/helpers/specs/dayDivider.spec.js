import { getUnixTime, subDays } from 'date-fns';
import { dayDivider } from '../dayDivider';

describe('dayDivider', () => {
  const now = new Date();
  const today = getUnixTime(now);

  it('labels the first message of each day', () => {
    expect(dayDivider({ createdAt: today })).toEqual({
      key: 'today',
      date: '',
    });
    expect(dayDivider({ createdAt: getUnixTime(subDays(now, 1)) })).toEqual({
      key: 'yesterday',
      date: '',
    });
    expect(dayDivider({ createdAt: getUnixTime(subDays(now, 9)) }).key).toBe(
      'date'
    );
  });

  it('skips messages on the same day as the previous one', () => {
    expect(dayDivider({ createdAt: today }, { createdAt: today - 1 })).toBe(
      null
    );
  });
});
