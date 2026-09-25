import { directorySections, driLabel } from '../customersHelper';

describe('customersHelper', () => {
  it('splits the directory into customers then unlinked channels, dropping empty sections', () => {
    const tala = { id: '1' };
    const teams = { id: 'unlinked-7', unlinked: true };
    expect(directorySections([teams, tala])).toEqual([
      { key: 'CUSTOMERS', customers: [tala] },
      { key: 'UNLINKED', customers: [teams] },
    ]);
    expect(directorySections([tala]).map(section => section.key)).toEqual([
      'CUSTOMERS',
    ]);
  });

  it('prefers DRI name, then email, then a dash', () => {
    expect(driLabel({ dri_name: 'Ana', dri_email: 'ana@x.com' })).toBe('Ana');
    expect(driLabel({ dri_name: null, dri_email: 'ana@x.com' })).toBe(
      'ana@x.com'
    );
    expect(driLabel({ dri_name: null, dri_email: null })).toBe('—');
  });
});
