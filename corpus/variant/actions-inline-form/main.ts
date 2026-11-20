export function form() {
  return async (data: FormData) => {
    'use server';
    return data.get('label');
  };
}
