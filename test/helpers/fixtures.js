// Row builders for tests. Names are made unique so tests never collide with each other.
let counter = 0;
export const uniq = (prefix) => `${prefix}-${++counter}`;

export const makeUser = (data, overrides = {}) => data.createUser({
  username: uniq('user'), display_name: 'Test Person', password_hash: 'not-a-real-hash', role: 'student', ...overrides,
});

export const makeOrder = (data, overrides = {}) => data.insertOrder({ name: uniq('part'), quantity: 1, ...overrides });

export const makeInventory = (data, overrides = {}) => data.insertInventory({ name: uniq('item'), quantity: 0, ...overrides });

export const makeColumn = (data, name = uniq('column')) => data.createBoardColumn({ name, sort: data.nextBoardColumnSort() });

export const makeMechanism = (data, name = uniq('mechanism')) => data.createMechanism({ name, sort: data.nextMechanismSort() });

// A custom part at the end of the given column.
export const makePart = (data, column, overrides = {}) => data.insertCustomPart({
  name: uniq('part'), quantity: 1, column_id: column.id, sort: data.nextCardSort(column.id), ...overrides,
});
