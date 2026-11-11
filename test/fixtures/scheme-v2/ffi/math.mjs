export async function add({ args }) {
  return args[0] + args[1]
}

export async function fail() {
  const error = new Error('host rejected')
  error.code = 'E-FFI-HOST'
  throw error
}

export async function echo({ args }) {
  return args
}

export async function object({ args }) {
  return args[0]
}

export async function never() {
  return new Promise(() => {})
}
