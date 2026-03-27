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
import { RolesGuard } from '../common/guards/roles.guard';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/schema/users.schema';
import { LegislaturaService } from './legislatura.service';
import { SearchExpedientesDto } from './dto/search-expedientes.dto';

@ApiTags('legislatura')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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

  @Get('legisladores/inactivos')
  @ApiOperation({ summary: 'Get inactive legisladores (from old mandates)' })
  async getLegisladoresInactivos() {
    try {
      const legisladores = await this.legislaturaService.getLegisladoresInactivos();
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

  @Get('expedientes/autores')
  @ApiOperation({ summary: 'Get distinct autores matching current filters' })
  async getDistinctAutores(@Query() filters: SearchExpedientesDto) {
    try {
      const autores = await this.legislaturaService.getDistinctAutores(filters);
      return { success: true, data: autores };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('expedientes/coautores')
  @ApiOperation({ summary: 'Get distinct coautores matching current filters' })
  async getDistinctCoautores(@Query() filters: SearchExpedientesDto) {
    try {
      const coautores = await this.legislaturaService.getDistinctCoautores(filters);
      return { success: true, data: coautores };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

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

  @Post('expedientes/:id/resync')
  @ApiOperation({ summary: 'Re-process a single expediente (download PDF + AI summary + embeddings)' })
  async resyncExpediente(@Param('id') id: string) {
    const expedienteId = parseInt(id);
    if (isNaN(expedienteId)) {
      throw new HttpException('Invalid expediente ID', HttpStatus.BAD_REQUEST);
    }
    try {
      const expediente = await this.legislaturaService.processExpediente(expedienteId);
      return { success: true, data: expediente };
    } catch (error) {
      this.logger.error(`Resync failed for expediente ${expedienteId}: ${error.message}`);
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
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
  @UseGuards(JwtAuthGuard, RolesGuard)
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger manual legisladores sync' })
  async triggerSyncLegisladores() {
    try {
      const result = await this.legislaturaService.syncLegisladores();
      // Also ensure legisladores from expedientes are inserted
      const ensureResult = await this.legislaturaService.ensureLegisladoresFromExpedientes();
      return { success: true, ...result, insertedInactive: ensureResult.inserted };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/expedientes')
  @UseGuards(JwtAuthGuard, RolesGuard)
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
  @UseGuards(JwtAuthGuard, RolesGuard)
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
  @UseGuards(JwtAuthGuard, RolesGuard)
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

  // ─── Comisiones ───────────────────────────────────

  @Get('comisiones')
  @ApiOperation({ summary: 'Get all comisiones (commissions) for filtering' })
  async getComisiones() {
    try {
      const comisiones = this.legislaturaService.getComisiones();
      return { success: true, data: comisiones };
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

  // ─── Sync Giros (admin) ──────────────────────────

  @Post('sync/giros')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trigger manual giros+ubicacion sync for recent expedientes' })
  @ApiQuery({ name: 'months', required: false, type: Number, description: 'Window size in months (default 6)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Offset months from now (default 0)' })
  async triggerSyncGiros(
    @Query('months') months?: string,
    @Query('offset') offset?: string,
  ) {
    try {
      const m = months ? parseInt(months) : 6;
      const o = offset ? parseInt(offset) : 0;
      const result = await this.legislaturaService.syncGirosForRecentExpedientes(m, o);
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  // ─── BAE ─────────────────────────────────────────

  @Get('bae')
  @ApiOperation({ summary: 'Get list of all synced BAEs' })
  @ApiQuery({ name: 'anoParlamentario', required: false, type: Number })
  async getBaes(@Query('anoParlamentario') anoParlamentario?: string) {
    try {
      const data = await this.legislaturaService.getBaes(
        anoParlamentario ? parseInt(anoParlamentario) : undefined,
      );
      return { success: true, data };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('bae/combined')
  @ApiOperation({ summary: 'Get expedientes from multiple BAEs combined' })
  @ApiQuery({ name: 'baes', required: true, description: 'Comma-separated BAE refs (nroOrden-anoParlamentario), e.g. 5-2025,4-2025' })
  async getCombinedBaeExpedientes(
    @Query('baes') baesParam: string,
    @Query() filters: SearchExpedientesDto,
  ) {
    try {
      if (!baesParam) {
        throw new HttpException('baes parameter is required', HttpStatus.BAD_REQUEST);
      }
      const baeRefs = baesParam.split(',').map((ref) => {
        const [nro, ano] = ref.trim().split('-').map(Number);
        if (isNaN(nro) || isNaN(ano)) {
          throw new HttpException(`Invalid BAE reference: ${ref}`, HttpStatus.BAD_REQUEST);
        }
        return { nroOrden: nro, anoParlamentario: ano };
      });

      const result = await this.legislaturaService.getCombinedBaesExpedientes(baeRefs, filters);
      return { success: true, ...result };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Get('bae/:nroOrden/:anoParlamentario')
  @ApiOperation({ summary: 'Get BAE with its expedientes (supports same filters as expedientes)' })
  async getBaeWithExpedientes(
    @Param('nroOrden') nroOrden: string,
    @Param('anoParlamentario') anoParlamentario: string,
    @Query() filters: SearchExpedientesDto,
  ) {
    try {
      const result = await this.legislaturaService.getBaeWithExpedientes(
        parseInt(nroOrden),
        parseInt(anoParlamentario),
        filters,
      );
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/bae')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync a specific BAE by nroOrden and anoParlamentario' })
  @ApiQuery({ name: 'nroOrden', required: true, type: Number })
  @ApiQuery({ name: 'anoParlamentario', required: true, type: Number })
  async triggerSyncBae(
    @Query('nroOrden') nroOrden: string,
    @Query('anoParlamentario') anoParlamentario: string,
  ) {
    try {
      if (!nroOrden || !anoParlamentario) {
        throw new HttpException('nroOrden and anoParlamentario are required', HttpStatus.BAD_REQUEST);
      }

      console.log(nroOrden, anoParlamentario)
      const result = await this.legislaturaService.syncBae(
        parseInt(nroOrden),
        parseInt(anoParlamentario),
      );
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/bae/latest')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check and sync the latest BAE for the current year' })
  async triggerSyncLatestBae() {
    try {
      const result = await this.legislaturaService.syncLatestBae();
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  @Post('sync/bae/year')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sync all BAEs for a specific year (for Postman/admin use)' })
  @ApiQuery({ name: 'anoParlamentario', required: true, type: Number })
  async triggerSyncBaeByYear(
    @Query('anoParlamentario') anoParlamentario: string,
  ) {
    try {
      if (!anoParlamentario) {
        throw new HttpException('anoParlamentario is required', HttpStatus.BAD_REQUEST);
      }
      const result = await this.legislaturaService.syncBaesByYear(parseInt(anoParlamentario));
      return { success: true, ...result };
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
