import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';

export interface AuthenticatedUser {
  email: string;
  accessToken: string;
}

/**
 * Boots the real application the same way `main.ts` does. `Test.createTestingModule`
 * does not run `main.ts`, so the global pipe and filters have to be applied here
 * or every validation error comes back in the wrong shape.
 */
export async function createVideoTestApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  return app;
}

/**
 * Registers, confirms and logs a user in, returning a usable access token.
 * The confirmation token is captured from the mail service rather than parsed
 * out of an email body.
 */
export async function registerAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<AuthenticatedUser> {
  const authService = app.get(AuthService);
  const mailService = (authService as unknown as { mailService: object })
    .mailService;

  let confirmationToken = '';
  jest
    .spyOn(mailService as never, 'sendConfirmationEmail')
    .mockImplementationOnce(((
      _email: string,
      _nickname: string,
      token: string,
    ) => {
      confirmationToken = token;
      return Promise.resolve();
    }) as never);

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  return {
    email,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}
