import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RefractrApi implements ICredentialType {
	name = 'refractrApi';

	displayName = 'Refractr API';

	icon: Icon = { light: 'file:refractr.svg', dark: 'file:refractr.dark.svg' };

	documentationUrl = 'https://refractr.io/docs/#authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 're_...',
			description:
				'Create a key in your Refractr dashboard. It works once your email address is confirmed.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.refractr.io',
			description: 'Only change this if Refractr support asked you to',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/api/v1/account/',
			method: 'GET',
		},
	};
}
