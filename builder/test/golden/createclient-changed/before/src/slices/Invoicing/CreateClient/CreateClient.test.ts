import {DeciderSpecification} from '@event-driven-io/emmett';
import {
    CreateClientCommand,
    CreateClientInitialState,
    decide,
    evolve,
} from './CreateClientCommand';
import {describe, it} from 'node:test';

describe('CreateClient Specification', () => {
    const given = DeciderSpecification.for({
        decide,
        evolve,
        initialState: CreateClientInitialState,
    });

    it('spec: Create a client', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1111111-1111-1111-1111-111111111111',
                name: 'Great GlenLtd',
                contactEmail: 'contact@greatglen.com',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .then([{
                type: 'ClientCreated',
                data: {
                    clientId: 'c1111111-1111-1111-1111-111111111111',
                    name: 'Great GlenLtd',
                    contactEmail: 'contact@greatglen.com',
                },
                metadata: {},
            }]);
    });

    it('spec: Empty name is rejected', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1111111-1111-1111-1111-111111111111',
                name: '',
                contactEmail: 'contact@greatglen.com',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows((err: any) => err.code === 'client_name_required' && err.message === 'Client name is required');
    });

    it('spec: Invalid contact email is rejected', () => {
        const command: CreateClientCommand = {
            type: 'CreateClient',
            data: {
                clientId: 'c1111111-1111-1111-1111-111111111111',
                name: 'Great GlenLtd',
                contactEmail: 'invalid-email',
            },
            metadata: {},
        };

        given([])
            .when(command)
            .thenThrows((err: any) => err.code === 'invalid_contact_email' && err.message === 'Contact email must be a valid email address');
    });
});
