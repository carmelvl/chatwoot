import {
  customerLabel,
  driLabel,
  customerConversationFilter,
} from '../customersHelper';

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

  it('builds a grip_account filter per customer', () => {
    expect(customerConversationFilter({ id: 'Acme', name: 'Acme' })).toEqual([
      {
        attribute_key: 'grip_account',
        filter_operator: 'equal_to',
        values: ['Acme'],
        query_operator: null,
        custom_attribute_type: 'conversation_attribute',
      },
    ]);
    expect(
      customerConversationFilter({ id: 'unlinked', name: null })[0]
    ).toMatchObject({ filter_operator: 'is_not_present', values: [] });
  });
});
