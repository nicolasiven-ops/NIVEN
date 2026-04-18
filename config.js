// N.IVEN runtime config — safe to ship to the browser.
// The publishable key is designed to be public; RLS policies protect the data.
window.NIVEN_CONFIG = {
  supabaseUrl: 'https://lymbzxuyjsfkgcbhmdzm.supabase.co',
  supabaseKey: 'sb_publishable_NZ8UexhhRrWLWqP19BdaRw_ryOqQjYq',

  // The single fixed auth identity. The frontend never asks for an email —
  // you only type the keyphrase, the email is attached here invisibly.
  // Change this to whatever email you used when creating the user in
  // Supabase Dashboard → Authentication → Users.
  authEmail: 'nicolas.iven@gmail.com',
};
