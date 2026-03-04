import { Controller, Patch, UseGuards, Body, Req, HttpCode, Get, Query, Put, Param, BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';
import { UserRole } from './schema/users.schema';
import { Roles } from 'src/common/decorators/roles.decorator';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async updateMe(@Req() req: any, @Body() updateUserDto: UpdateUserDto) {
    const userId = req.user?.userId;
    return this.usersService.update(userId, updateUserDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async findAll(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search: string,
  ) {
    return this.usersService.findAllForAdmin({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 10,
      search,
    });
  }

  @Put(':id/role')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async updateRole(
    @Param('id') id: string,
    @Body('role') role: UserRole
  ) {
    if (!Object.values(UserRole).includes(role)) {
      throw new BadRequestException('Invalid role value');
    }

    return this.usersService.assignRole(id, role);
  }
}
