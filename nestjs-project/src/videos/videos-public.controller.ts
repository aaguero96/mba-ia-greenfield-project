import {
  Controller,
  Get,
  Header,
  Headers,
  HttpStatus,
  Param,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideosService } from './videos.service';
import type { StreamResponse } from './videos.service';

/**
 * The anonymous read surface. Every route here is explicitly `@Public()`,
 * because the global JwtAuthGuard denies anything that is not.
 */
@ApiTags('videos')
@Controller('videos')
export class VideosPublicController {
  constructor(private readonly videosService: VideosService) {}

  @Public()
  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      'Returns the video and its unique URLs. Only ready videos are visible anonymously; the owner also sees their own drafts.',
  })
  @ApiResponse({ status: 200, description: 'The video', type: VideoResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or not ready and requested by someone else',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @Param('publicId') publicId: string,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<VideoResponseDto> {
    return this.videosService.getPublicVideo(publicId, user?.sub);
  }

  @Public()
  // A player issues many Range requests per playback, which would trip a limit
  // designed for login attempts.
  @SkipThrottle()
  @Get(':publicId/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Serves the video with HTTP Range support, so playback starts without downloading the whole file. Without a Range header the full body is returned with Accept-Ranges.',
  })
  @ApiResponse({ status: 200, description: 'Full body' })
  @ApiResponse({ status: 206, description: 'Partial content for the requested range' })
  @ApiResponse({ status: 416, description: 'The requested range is not satisfiable' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') range: string | undefined,
    @Res() response: Response,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<void> {
    const result = await this.videosService.openStream(
      publicId,
      range,
      user?.sub,
    );

    this.sendStream(result, response);
  }

  @Public()
  @SkipThrottle()
  @Get(':publicId/thumbnail')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({
    summary: 'Get the generated thumbnail',
    description: 'Serves the JPEG the worker cut from a frame of the video.',
  })
  @ApiResponse({ status: 200, description: 'The thumbnail image' })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or no thumbnail has been generated yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('publicId') publicId: string,
    @Res() response: Response,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<void> {
    const result = await this.videosService.openThumbnail(publicId, user?.sub);

    this.sendStream(result, response);
  }

  @Public()
  @Get(':publicId/download')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived pre-signed URL. The file is served by object storage, so the full transfer never passes through the API.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the pre-signed URL' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('publicId') publicId: string,
    @Res() response: Response,
    @CurrentUser() user: JwtPayload | undefined,
  ): Promise<void> {
    const url = await this.videosService.buildDownloadUrl(publicId, user?.sub);

    response.redirect(HttpStatus.FOUND, url);
  }

  /**
   * Writes a stream result to the response. Piping (rather than buffering) is
   * what keeps memory flat and preserves backpressure.
   */
  private sendStream(result: StreamResponse, response: Response): void {
    if (result.kind === 'unsatisfiable') {
      response
        .status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        .setHeader('Content-Range', `bytes */${result.size}`);
      response.end();
      return;
    }

    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', result.contentType);
    response.setHeader('Content-Length', result.contentLength);

    if (result.kind === 'partial') {
      response.setHeader('Content-Range', result.contentRange);
      response.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      response.status(HttpStatus.OK);
    }

    result.stream.pipe(response);
  }
}
