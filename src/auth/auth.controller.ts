import { Controller, Post, Body, UseGuards, Get, Req, Res, HttpCode, HttpStatus, Query, Param } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { LoginUserDto } from '../users/dto/login-user.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RefreshTokenGuard } from '../common/guards/refresh-token.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../users/schema/users.schema';
import { ConfigService } from '@nestjs/config';
import { UsersService } from 'src/users/users.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService, private configService: ConfigService, private usersService: UsersService) { }

    @Post('register')
    @ApiOperation({ summary: 'Register a new user' })
    @ApiResponse({ status: 201, description: 'User successfully registered' })
    @ApiResponse({ status: 409, description: 'Email already exists' })
    async register(@Body() createUserDto: CreateUserDto) {
        return this.authService.register(createUserDto);
    }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Login user' })
    @ApiResponse({ status: 200, description: 'Login successful' })
    @ApiResponse({ status: 401, description: 'Invalid credentials' })
    async login(@Body() loginUserDto: LoginUserDto) {
        return this.authService.login(loginUserDto);
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Logout user' })
    async logout(@Req() req) {
        await this.authService.logout(req.user.userId);
        return { message: 'Logged out successfully' };
    }

    @Post('refresh')
    @UseGuards(RefreshTokenGuard)
    @ApiOperation({ summary: 'Refresh access token' })
    async refreshTokens(@Req() req) {
        return this.authService.refreshTokens(req.user.userId, req.user.refreshToken);
    }

    @Get('profile')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get user profile' })
    async getProfile(@Req() req) {
        return this.authService.getProfile(req.user.userId);
    }

    @Get('admin-test')
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles(UserRole.ADMIN)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Admin only route' })
    adminTest() {
        return { message: 'Welcome admin!' };
    }

    @Post('forgot-password')
    @ApiOperation({ summary: 'Request password reset' })
    @ApiResponse({ status: 200, description: 'Reset email sent' })
    async forgotPassword(@Body('email') email: string) {
        return this.authService.requestPasswordReset(email);
    }

    @Post('reset-password')
    @ApiOperation({ summary: 'Reset password with token' })
    @ApiResponse({ status: 200, description: 'Password reset successful' })
    @ApiResponse({ status: 400, description: 'Invalid or expired token' })
    async resetPassword(
        @Body('token') token: string,
        @Body('newPassword') newPassword: string,
    ) {
        return this.authService.resetPassword(token, newPassword);
    }

    @Post('change-password')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Change password (authenticated user)' })
    async changePassword(
        @Req() req,
        @Body() body: { currentPassword: string; newPassword: string },
    ) {
        await this.usersService.changePassword(
            req.user.userId,
            body.currentPassword,
            body.newPassword,
        );
        return { message: 'Password changed successfully' };
    }

    @Get('verify-email/:token')
    @ApiOperation({ summary: 'Verify email with token' })
    async verifyEmail(@Param('token') token: string) {
        return this.authService.verifyEmail(token);
    }

    @Post('resend-verification')
    @ApiOperation({ summary: 'Resend verification email' })
    async resendVerification(@Body('email') email: string) {
        return this.authService.resendVerificationEmail(email);
    }
}