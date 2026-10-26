import { SetMetadata } from '@nestjs/common';

/** Routes open without a login (login pages, webhooks, landing pages). */
export const PUBLIC = 'px:public';
export const Public = () => SetMetadata(PUBLIC, true);
