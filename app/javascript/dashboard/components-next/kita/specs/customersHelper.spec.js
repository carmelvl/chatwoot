import { customerLabel, driLabel } from '../customersHelper';

describe('customersHelper', () => {
  it('labels unlinked rows and keeps named customers', () => {
    expect(customerLabel({ id: 'unlinked', name: null }, 'Unlinked')).toBe(
      'Unlinked'
    );
    expect(customerLabel({ id: 'Acme', name: 'Acme' }, 'Unlinked')).toBe(
      'Acme'
    );
  });

  it('prefers DRI name, then email, then a dash', () => {
    expect(driLabel({ dri_name: 'Ana', dri_email: 'ana@x.com' })).toBe('Ana');
    expect(driLabel({ dri_name: null, dri_email: 'ana@x.com' })).toBe(
      'ana@x.com'
    );
    expect(driLabel({ dri_name: null, dri_email: null })).toBe('—');
  });
});
