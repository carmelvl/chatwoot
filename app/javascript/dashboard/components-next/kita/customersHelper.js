export const UNLINKED_CUSTOMER_ID = 'unlinked';

export const isUnlinkedCustomer = customer =>
  customer.id === UNLINKED_CUSTOMER_ID;

export const customerLabel = (customer, unlinkedLabel) =>
  isUnlinkedCustomer(customer) ? unlinkedLabel : customer.name;

export const driLabel = customer =>
  customer.dri_name || customer.dri_email || '—';

export const customerConversationFilter = customer => {
  if (isUnlinkedCustomer(customer)) {
    return [
      {
        attribute_key: 'grip_account',
        filter_operator: 'is_not_present',
        values: [],
        query_operator: null,
        custom_attribute_type: 'conversation_attribute',
      },
    ];
  }
  return [
    {
      attribute_key: 'grip_account',
      filter_operator: 'equal_to',
      values: [customer.name],
      query_operator: null,
      custom_attribute_type: 'conversation_attribute',
    },
  ];
};
