/* eslint no-multi-spaces: 0 */

import { mergeMap } from 'rxjs/operators'
import { makeScheduler, expectToRejectWithMessage } from '../__tests__/utils'

import Database from '../Database'
import { appSchema, tableSchema } from '../Schema'
import { field, date, readonly } from '../decorators'
import { noop } from '../utils/fp'
import { sanitizedRaw } from '../RawRecord'

import Model, { experimentalSetOnlyMarkAsChangedIfDiffers } from './index'

const mockSchema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'mock',
      columns: [
        { name: 'name', type: 'string' },
        { name: 'otherfield', type: 'string' },
        { name: 'col3', type: 'string' },
        { name: 'col4', type: 'string', isOptional: true },
        { name: 'number', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'mock_created',
      columns: [{ name: 'created_at', type: 'number' }],
    }),
    tableSchema({
      name: 'mock_updated',
      columns: [{ name: 'updated_at', type: 'number' }],
    }),
    tableSchema({
      name: 'mock_created_updated',
      columns: [{ name: 'created_at', type: 'number' }, { name: 'updated_at', type: 'number' }],
    }),
  ],
})

class MockModel extends Model {
  static table = 'mock'

  @field('name')
  name

  @field('otherfield')
  otherfield
}

class MockModelCreated extends Model {
  static table = 'mock_created'

  @readonly
  @date('created_at')
  createdAt
}

class MockModelUpdated extends Model {
  static table = 'mock_updated'

  @readonly
  @date('updated_at')
  updatedAt
}

class MockModelCreatedUpdated extends Model {
  static table = 'mock_created_updated'

  @readonly
  @date('created_at')
  createdAt

  @readonly
  @date('updated_at')
  updatedAt
}

const makeDatabase = ({ actionsEnabled = false } = {}) =>
  new Database({
    adapter: { schema: mockSchema },
    modelClasses: [MockModel, MockModelCreated, MockModelUpdated, MockModelCreatedUpdated],
    actionsEnabled,
  })

describe('Model', () => {
  it('exposes collections', () => {
    const database = makeDatabase()
    const model = new MockModel(database.collections.get('mock'), {})
    expect(model.collections).toBe(database.collections)
    expect(model.collections.get('mock_created').modelClass).toBe(MockModelCreated)
  })
})

describe('CRUD', () => {
  it('_prepareCreate: can instantiate new records', () => {
    const database = makeDatabase()
    const collection = database.collections.get('mock')
    const m1 = MockModel._prepareCreate(collection, record => {
      expect(record._isEditing).toBe(true)
      record.name = 'Some name'
    })

    expect(m1.collection).toBe(collection)
    expect(m1._isEditing).toBe(false)
    expect(m1._isCommitted).toBe(false)
    expect(m1.id.length).toBe(16)
    expect(m1.createdAt).toBe(undefined)
    expect(m1.updatedAt).toBe(undefined)
    expect(m1.name).toBe('Some name')
    expect(m1._raw).toEqual({
      id: m1.id,
      _status: 'created',
      _changed: '',
      name: 'Some name',
      otherfield: '',
      col3: '',
      col4: null,
      number: 0,
    })
  })
  it('can update a record', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()
    const spyBatchDB = jest.spyOn(database, 'batch')

    const collection = database.collections.get('mock')
    const m1 = await collection.create(record => {
      record.name = 'Original name'
    })

    const spyOnPrepareUpdate = jest.spyOn(m1, 'prepareUpdate')
    const observer = jest.fn()
    m1.observe().subscribe(observer)

    expect(m1._isEditing).toBe(false)

    await m1.update(record => {
      expect(m1._isEditing).toBe(true)
      record.name = 'New name'
    })

    expect(spyBatchDB).toHaveBeenCalledWith(m1)
    expect(spyOnPrepareUpdate).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledTimes(2)

    expect(m1.name).toBe('New name')
    expect(m1.updatedAt).toBe(undefined)
    expect(m1._isEditing).toBe(false)
    expect(m1._isCommitted).toBe(true)
    expect(m1._hasPendingUpdate).toBe(false)
  })
  it('can prepare an update', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const collection = database.collections.get('mock')

    const m1 = await collection.create(record => {
      record.name = 'Original name'
    })

    expect(database.adapter.batch).toHaveBeenCalledTimes(1)

    const observer = jest.fn()
    m1.observe().subscribe(observer)

    const preparedUpdate = m1.prepareUpdate(record => {
      expect(m1._isEditing).toBe(true)
      record.name = 'New name'
    })

    expect(preparedUpdate).toBe(m1)

    expect(m1.name).toBe('New name')
    expect(m1.updatedAt).toBe(undefined)
    expect(m1._isEditing).toBe(false)
    expect(m1._hasPendingUpdate).toBe(true)
    expect(database.adapter.batch).toHaveBeenCalledTimes(1)

    expect(observer).toHaveBeenCalledTimes(1)

    expect(m1._isCommitted).toBe(true)

    // need to call batch or a dev check will get angry
    database.batch(preparedUpdate)
  })
  it('can destroy a record permanently', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const collection = database.collections.get('mock')
    const storeDestroy = jest.spyOn(collection, '_destroyPermanently')

    const m1 = await collection.create()

    const nextObserver = jest.fn()
    const completionObserver = jest.fn()
    m1.observe().subscribe(nextObserver, null, completionObserver)

    await m1.destroyPermanently()

    expect(database.adapter.batch).toHaveBeenCalledWith([['destroyPermanently', m1]])
    expect(storeDestroy).toHaveBeenCalledWith(m1)
    expect(nextObserver).toHaveBeenCalledTimes(1)
    expect(completionObserver).toHaveBeenCalledTimes(1)
  })
})

describe('Safety features', () => {
  it('throws if batch is not called synchronously with prepareUpdate', async () => {
    // TODO: No clue how to implement this test
  })
  it('disallows field changes outside of create/update', () => {
    const database = makeDatabase()
    const model = new MockModel(database.collections.get('mock'), {})

    expect(() => {
      model.name = 'new'
    }).toThrow()
    expect(() => {
      model.otherfield = 'new'
    }).toThrow()
    expect(() => {
      model._setRaw('name', 'new')
    }).toThrow()
  })
  it('disallows changes to just-deleted records', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const m1 = await database.collections.get('mock').create()
    await m1.destroyPermanently()

    await expect(
      m1.update(() => {
        m1.name = 'new'
      }),
    ).rejects.toBeInstanceOf(Error)
  })
  it('disallows changes to previously-deleted records', async () => {
    const database = makeDatabase()

    const m1 = new MockModel(database.collections.get('mock'), {
      _status: 'deleted',
    })

    await expect(
      m1.update(() => {
        m1.name = 'new'
      }),
    ).rejects.toBeInstanceOf(Error)
  })
  it('diallows direct manipulation of id', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const model = await database.collections.get('mock').create()

    await expect(
      model.update(() => {
        model.id = 'newId'
      }),
    ).rejects.toBeInstanceOf(Error)
  })

  it('disallows operations on uncommited records', async () => {
    const database = makeDatabase()
    const model = MockModel._prepareCreate(database.collections.get('mock'), () => {})
    expect(model._isCommitted).toBe(false)

    await expectToRejectWithMessage(model.update(() => {}), /uncommitted/)
    await expectToRejectWithMessage(model.markAsDeleted(), /uncommitted/)
    await expectToRejectWithMessage(model.destroyPermanently(), /uncommitted/)
    expect(() => model.observe()).toThrow(/uncommitted/)
  })
  it('disallows changes on records with pending updates', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const model = new MockModel(database.collections.get('mock'), {})
    model.prepareUpdate()
    expect(() => {
      model.prepareUpdate()
    }).toThrow(/pending update/)
    await expectToRejectWithMessage(model.update(() => {}), /pending update/)

    // need to call batch or a dev check will get angry
    database.batch(model)
  })
  it('disallows writes outside of an action', async () => {
    const database = makeDatabase({ actionsEnabled: true })
    database.adapter.batch = jest.fn()

    const model = await database.action(() => database.collections.get('mock').create())

    await expectToRejectWithMessage(
      model.update(noop),
      /can only be called from inside of an Action/,
    )

    await expectToRejectWithMessage(
      model.markAsDeleted(),
      /can only be called from inside of an Action/,
    )

    await expectToRejectWithMessage(
      model.markAsDeleted(),
      /can only be called from inside of an Action/,
    )

    // check that no throw inside action
    await database.action(async () => {
      await model.update(noop)
      await model.markAsDeleted()
      await model.destroyPermanently()
    })
  })
})

describe('Automatic created_at/updated_at', () => {
  it('_prepareCreate: sets created_at on create if model defines it', () => {
    const database = makeDatabase()
    const m1 = MockModelCreated._prepareCreate(database.collections.get('mock_created'), noop)

    expect(m1.createdAt).toBeInstanceOf(Date)
    expect(+m1.createdAt).toBeGreaterThan(1500000000000)
    expect(m1.updatedAt).toBe(undefined)
  })
  it('_prepareCreate: sets created_at, updated_at on create if model defines it', () => {
    const database = makeDatabase()
    const m1 = MockModelCreatedUpdated._prepareCreate(
      database.collections.get('mock_created_updated'),
      noop,
    )

    expect(m1.createdAt).toBeInstanceOf(Date)
    expect(+m1.createdAt).toBe(+m1.updatedAt)
  })
  it('touches updated_at on update if model defines it', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const m1 = await database.collections.get('mock_updated').create(record => {
      record._raw.updated_at -= 100
    })
    const updatedAt = +m1.updatedAt

    await m1.update()

    expect(+m1.updatedAt).toBeGreaterThan(updatedAt)
  })
})

describe('RawRecord manipulation', () => {
  it('allows raw access via _getRaw', () => {
    const model = new MockModel(null, {
      col1: 'val1',
      col2: false,
      col3: null,
    })

    expect(model._getRaw('col1')).toBe('val1')
    expect(model._getRaw('col2')).toBe(false)
    expect(model._getRaw('col3')).toBe(null)

    model._raw.col1 = 'val2'
    expect(model._getRaw('col1')).toBe('val2')
  })
  it('allows raw writes via _setRaw', () => {
    const model = new MockModel(
      { schema: mockSchema.tables.mock },
      sanitizedRaw(
        {
          name: 'val1',
        },
        mockSchema.tables.mock,
      ),
    )

    model._isEditing = true
    model._setRaw('name', 'val2')
    model._setRaw('otherfield', 'val3')

    expect(model._raw.name).toBe('val2')
    expect(model._raw.otherfield).toBe('val3')
  })
})

describe('Sync status fields', () => {
  it('adds to changes on _setRaw', () => {
    const model = new MockModel(
      { schema: mockSchema.tables.mock },
      sanitizedRaw({}, mockSchema.tables.mock),
    )

    model._isEditing = true
    model._setRaw('name', 'val1')
    model._setRaw('otherfield', 'val2')

    expect(model._raw._status).toBe('created')
    expect(model._raw._changed).toBe('')

    model._raw._status = 'updated'

    model._setRaw('col3', 'val3')
    model._setRaw('col3', 'val4')
    model._setRaw('col4', 'val5')
    model._setRaw('col3', 'val6')

    expect(model._raw._status).toBe('updated')
    expect(model._raw._changed).toBe('col3,col4')

    const model2 = new MockModel(
      { schema: mockSchema.tables.mock },
      sanitizedRaw({ id: 'xx', _status: 'synced' }, mockSchema.tables.mock),
    )
    model2._isEditing = true
    model2._setRaw('name', 'val1')

    expect(model2._raw._status).toBe('updated')
    expect(model2._raw._changed).toBe('name')
  })
  it('adds to changes on _setRaw (new behavior)', async () => {
    const model = new MockModel(
      { schema: mockSchema.tables.mock },
      sanitizedRaw(
        {
          col3: '',
          number: 0,
        },
        mockSchema.tables.mock,
      ),
    )

    experimentalSetOnlyMarkAsChangedIfDiffers(true)

    model._isEditing = true
    model._raw.id = 'xxx'
    model._raw._status = 'updated'

    model._setRaw('name', null) // ensure we're comparing sanitized values
    model._setRaw('otherfield', '')
    model._setRaw('col3', 'foo')
    model._setRaw('col4', undefined)
    model._setRaw('number', NaN)
    expect(model._raw._changed).toBe('col3')
    model._setRaw('number', 10)

    expect(model._raw).toEqual({
      _status: 'updated',
      _changed: 'col3,number',
      id: 'xxx',
      name: '',
      otherfield: '',
      col3: 'foo',
      col4: null,
      number: 10,
    })

    experimentalSetOnlyMarkAsChangedIfDiffers(false)
  })
  it('marks new records as status:created', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const mock = await database.collections.get('mock').create(record => {
      record.name = 'Initial name'
    })

    expect(mock._raw._status).toBe('created')
    expect(mock._raw._changed).toBe('')

    expect(mock.syncStatus).toBe('created')

    // updating a status:created record doesn't change anything
    await mock.update(record => {
      record.name = 'New name'
    })

    expect(mock.syncStatus).toBe('created')
    expect(mock._raw._changed).toBe('')
  })
  it('marks updated records with changed fields', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const mock = new MockModel(
      database.collections.get('mock'),
      sanitizedRaw(
        {
          id: '',
          _status: 'synced',
          name: 'Initial name',
        },
        mockSchema.tables.mock,
      ),
    )

    // update
    await mock.update(record => {
      record.name = 'New name'
    })

    expect(mock._raw._status).toBe('updated')
    expect(mock._raw._changed).toBe('name')

    // change another field
    await mock.update(record => {
      record.otherfield = 'New value'
    })

    expect(mock._raw._status).toBe('updated')
    expect(mock._raw._changed).toBe('name,otherfield')

    // no duplicated change fields
    await mock.update(record => {
      record.name = 'New name 2'
    })

    expect(mock._raw._changed).toBe('name,otherfield')
  })
  it('marks update_at as updated when auto-touched', async () => {
    const database = makeDatabase()
    database.adapter.batch = jest.fn()

    const m1 = new MockModelUpdated(database.collections.get('mock_updated'), {})
    await m1.update()

    expect(m1._raw._status).toBe('updated')
    expect(m1._raw._changed).toBe('updated_at')
  })
})

describe('Model observation', () => {
  it('notifies observers of changes and deletion', () => {
    const model = new MockModel(null, {})
    const scheduler = makeScheduler()

    const changes__ = '--a---a----a-a---b'
    const a________ = '---x|'
    const b________ = '--------x|'
    const c________ = 'x|'
    const aExpected = '---m--m----m-m---|'
    const bExpected = '--------m--m-m---|'
    const cExpected = 'm-m---m----m-m---|'

    scheduler.hot(changes__).subscribe(event => {
      event === 'a' ? model._notifyChanged() : model._notifyDestroyed()
    })

    const a$ = scheduler.hot(a________).pipe(mergeMap(() => model.observe()))
    const b$ = scheduler.hot(b________).pipe(mergeMap(() => model.observe()))
    const c$ = scheduler.hot(c________).pipe(mergeMap(() => model.observe()))

    scheduler.expectObservable(a$).toBe(aExpected, { m: model })
    scheduler.expectObservable(b$).toBe(bExpected, { m: model })
    scheduler.expectObservable(c$).toBe(cExpected, { m: model })
    scheduler.flush()
  })
})
