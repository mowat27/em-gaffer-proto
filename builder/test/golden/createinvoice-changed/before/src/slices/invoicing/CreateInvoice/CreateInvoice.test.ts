import {describe, it} from 'node:test';
import {DeciderSpecification} from '@event-driven-io/emmett';
import {
    CreateInvoiceCommand,
    CreateInvoiceInitialState,
    decide,
    evolve,
} from './CreateInvoiceCommand';

describe('CreateInvoice Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateInvoiceInitialState,
    });

    it('spec: Create an invoice', () => {
        const clientId = 'c8b6b230-0eb5-43ea-9fc6-0fa3f6797cb3';
        const invoiceId = 'd895b6c3-9824-44a3-b45d-79e0a0d4c82b';
        const amount = 1500;
        const date = '2025-01-15';

        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount,
                date,
            },
            metadata: {},
        };

        given([
            {
                type: 'ClientCreated',
                data: {
                    clientId,
                },
                metadata: {},
            },
        ])
            .when(command)
            .then([
                {
                    type: 'InvoiceCreated',
                    data: {
                        invoiceId,
                        clientId,
                        amount,
                        date,
                    },
                    metadata: {},
                },
            ]);
    });

    it('spec: Unknown client is rejected', () => {
        const clientId = 'c8b6b230-0eb5-43ea-9fc6-0fa3f6797cb3';
        const invoiceId = 'd895b6c3-9824-44a3-b45d-79e0a0d4c82b';

        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount: 1500,
                date: '2025-01-15',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows((err: any) => err?.code === 'client_does_not_exist');
    });

    it('spec: Zero amount is rejected', () => {
        const clientId = 'c8b6b230-0eb5-43ea-9fc6-0fa3f6797cb3';
        const invoiceId = 'd895b6c3-9824-44a3-b45d-79e0a0d4c82b';

        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount: 0,
                date: '2025-01-15',
            },
            metadata: {},
        };

        given([
            {
                type: 'ClientCreated',
                data: {
                    clientId,
                },
                metadata: {},
            },
        ])
            .when(command)
            .thenThrows((err: any) => err?.code === 'zero_amount');
    });

    it('throws when invoice was already created', () => {
        const clientId = 'c8b6b230-0eb5-43ea-9fc6-0fa3f6797cb3';
        const invoiceId = 'd895b6c3-9824-44a3-b45d-79e0a0d4c82b';

        const command: CreateInvoiceCommand = {
            type: 'CreateInvoice',
            data: {
                invoiceId,
                clientId,
                amount: 1500,
                date: '2025-01-15',
            },
            metadata: {},
        };

        given([
            {
                type: 'ClientCreated',
                data: {
                    clientId,
                },
                metadata: {},
            },
            {
                type: 'InvoiceCreated',
                data: {
                    invoiceId,
                    clientId,
                    amount: 1500,
                    date: '2025-01-15',
                },
                metadata: {},
            },
        ])
            .when(command)
            .thenThrows((err: any) => err?.code === 'already_created');
    });
});
