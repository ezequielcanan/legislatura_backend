import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/schema/users.schema';
import { LegislaturaService } from './legislatura.service';
import { SearchExpedientesDto } from './dto/search-expedientes.dto';

@ApiTags('legislatura')
@Controller('legislatura')
export class LegislaturaController {
  private readonly logger = new Logger(LegislaturaController.name);

  constructor(private readonly legislaturaService: LegislaturaService) {}

  // ─── Bloques ─────────────────────────────────────

  @Get('bloques')
  @ApiOperation({ summary: 'Get all active bloques (parties)' })
  async getBloques() {
    try {
      const bloques = await this.legislaturaService.getBloques();
      return { success: true, data: bloques };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('bloques/counts')
  @ApiOperation({ summary: 'Get bloques with legislator counts from API' })
  async getBloquesWithCounts() {
    try {
      const data = await this.legislaturaService.getBloquesWithCounts();
      return { success: true, data };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─── Legisladores ────────────────────────────────

  @Get('legisladores')
  @ApiOperation({ summary: 'Get all active legisladores' })
  @ApiQuery({ name: 'bloqueId', required: false, type: Number })
  async getLegisladores(@Query('bloqueId') bloqueId?: string) {
    try {
      const legisladores = await this.legislaturaService.getLegisladores(
        bloqueId ? parseInt(bloqueId) : undefined,
      );
      return { success: true, data: legisladores };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('legisladores/:id')
  @ApiOperation({ summary: 'Get legislador detail (includes comisiones)' })
  async getLegisladorById(@Param('id') id: string) {
    try {
      const legislador = await this.legislaturaService.getLegisladorDetail(parseInt(id));
      return { success: true, data: legislador };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  // ─── Expedientes ─────────────────────────────────

  @Get('expedientes')
  @ApiOperation({ summary: 'Search and filter expedientes' })
  async searchExpedientes(@Query() filters: SearchExpedientesDto) {
    try {
      const result = await this.legislaturaService.searchExpedientes(filters);
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('expedientes/grouped')
  @ApiOperation({ summary: 'Get expedientes grouped by date' })
  @ApiQuery({ name: 'days', required: false, type: Number })
  async getExpedientesGrouped(@Query('days') days?: string) {
    try {
      const numDays = days ? parseInt(days) : 30;
      const dateTo = new Date();
      const dateFrom = new Date();
      dateFrom.setDate(dateFrom.getDate() - numDays);
      
      const data = await this.legislaturaService.getExpedientesGroupedByDate(
        dateFrom.toISOString(),
        dateTo.toISOString(),
      );
      return { success: true, data };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('expedientes/:id')
  @ApiOperation({ summary: 'Get expediente by ID' })
  async getExpedienteById(@Param('id') id: string) {
    try {
      const expediente = await this.legislaturaService.getExpedienteById(parseInt(id));
      return { success: true, data: expediente };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  @Get('legisladores/:id/expedientes')
  @ApiOperation({ summary: 'Get expedientes by legislador' })
  async getExpedientesByLegislador(@Param('id') id: string) {
    try {
      const expedientes = await this.legislaturaService.getExpedientesByLegislador(parseInt(id));
      return { success: true, data: expedientes };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─── Sync & Admin ────────────────────────────────

  @Post('sync/bloques')
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger manual bloques sync' })
  async triggerSyncBloques() {
    try {
      const result = await this.legislaturaService.syncBloques();
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/legisladores')
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger manual legisladores sync' })
  async triggerSyncLegisladores() {
    try {
      const result = await this.legislaturaService.syncLegisladores();
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/expedientes')
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger manual expedientes sync for today' })
  async triggerSyncExpedientes() {
    try {
      const result = await this.legislaturaService.syncTodayExpedientes();
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/expedientes/range')
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync expedientes for a date range (dd/mm/yyyy)' })
  async triggerSyncExpedientesRange(
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    try {
      if (!from || !to) {
        throw new HttpException('Both from and to dates required (dd/mm/yyyy)', HttpStatus.BAD_REQUEST);
      }
      const result = await this.legislaturaService.syncExpedientesByDateRange(from, to);
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/full')
  @UseGuards(JwtAuthGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger full sync (bloques + legisladores + today expedientes)' })
  async triggerFullSync() {
    try {
      const bloques = await this.legislaturaService.syncBloques();
      const legisladores = await this.legislaturaService.syncLegisladores();
      const expedientes = await this.legislaturaService.syncTodayExpedientes();
      return {
        success: true,
        bloques,
        legisladores,
        expedientes,
      };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─── Stats ───────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Get legislatura statistics' })
  async getStats() {
    try {
      const stats = await this.legislaturaService.getStats();
      return { success: true, data: stats };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
