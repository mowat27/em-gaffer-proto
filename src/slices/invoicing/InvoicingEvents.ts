import type {Event} from '@event-driven-io/emmett';

type CommonMeta = {
    stream_name?: string;
    userId?: string;
    correlation_id?: string;
    causation_id?: string;
};

export type ClientCreated = Event<'ClientCreated', {
    clientId: string;
    name: string;
    contactEmail: string;
}, CommonMeta>;

export type InvoiceCreated = Event<'InvoiceCreated', {
    invoiceId: string;
    clientId: string;
    amount: number;
    date: string;
}, CommonMeta>;

export type InvoicingEvents = ClientCreated | InvoiceCreated;
